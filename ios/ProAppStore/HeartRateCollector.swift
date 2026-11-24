import CoreBluetooth
import UIKit

/// Run's strap heart rate (#631), the Core Bluetooth counterpart of LocationCollector. Collects only while a credential
/// exists, a sensor is chosen, a heart-rate grant is current (not disabled, its app not paused, Pause all off) and the
/// queue has room. The chosen sensor is kept as a pending connection, which iOS holds across backgrounding and
/// locking (`bluetooth-central`); scanning happens only from the foreground "Choose sensor" sheet.
@MainActor
final class HeartRateCollector: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    struct Sensor: Identifiable, Equatable { let id: UUID; let name: String }

    @Published private(set) var bluetooth: CBManagerState = .unknown
    /// Advertised names seen by the open "Choose sensor" sheet. In memory only.
    @Published private(set) var discovered: [Sensor] = []
    @Published private(set) var connected = false
    @Published private(set) var lastBpm: Int?
    @Published private(set) var lastReadingAt: Date?

    private let repository: CompanionRepository
    private var local: LocalStore { repository.local }
    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var scanning = false
    private var policy = HeartRatePolicy()
    private var lastSyncAttempt = Date.distantPast
    private static let service = CBUUID(string: HeartRate.SERVICE)
    private static let measurement = CBUUID(string: HeartRate.MEASUREMENT)

    init(repository: CompanionRepository) {
        self.repository = repository
        super.init()
        // Created at launch only when a sensor was chosen, so iOS can restore the connection after terminating the app
        // and Bluetooth permission is never asked before the user picks a sensor.
        if local.heartRateSensor != nil { start() }
    }

    private func start() {
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionRestoreIdentifierKey: "online.proappstore.heart-rate"])
    }

    /// Current heart-rate grants for new readings.
    private func recipients(at: Int64) -> [String] {
        HeartRatePolicy.recipients(local.entries(), blocked: local.blocked(), pausedApps: local.pausedApps(), at: at)
    }

    var shouldCollect: Bool {
        repository.token() != nil && !local.paused && local.heartRateSensor != nil && !recipients(at: CompanionRepository.now()).isEmpty
            && ((try? local.heartRateCount()) ?? HeartRatePolicy.MAX_QUEUE) < HeartRatePolicy.MAX_QUEUE
    }

    /// Connects to or lets go of the chosen sensor to match the rules. Called on launch, activation, every state change.
    func evaluate() {
        guard let central, central.state == .poweredOn else { return }
        if shouldCollect, let id = local.heartRateSensor {
            if peripheral?.identifier != id { peripheral = central.retrievePeripherals(withIdentifiers: [id]).first; peripheral?.delegate = self }
            // A pending connect does not time out: iOS completes it whenever the strap is in range, even while locked.
            if let peripheral, peripheral.state == .disconnected { central.connect(peripheral) }
            connected = peripheral?.state == .connected // a connection restored after relaunch
        } else if let peripheral {
            central.cancelPeripheralConnection(peripheral)
            self.peripheral = nil; connected = false
        }
    }

    // MARK: Choose sensor (foreground sheet only)

    func startScan() {
        start(); discovered = []; scanning = true
        if central?.state == .poweredOn { central?.scanForPeripherals(withServices: [Self.service]) }
    }

    func stopScan() { scanning = false; central?.stopScan() }

    func choose(_ sensor: Sensor) {
        stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        peripheral = nil; connected = false; policy = HeartRatePolicy()
        local.heartRateSensor = sensor.id
        try? local.record(.heartRate, detail: "sensor_chosen")
        evaluate()
    }

    /// Lets go of the sensor and forgets its identifier.
    func forget() {
        local.heartRateSensor = nil
        try? local.record(.heartRate, detail: "forgotten")
        evaluate()
        lastBpm = nil; lastReadingAt = nil
    }

    /// The activity-log detail for a Bluetooth state, nil for transient ones.
    nonisolated static func name(_ state: CBManagerState) -> String? {
        switch state {
        case .poweredOff: "off"
        case .poweredOn: "on"
        case .unauthorized: "unauthorized"
        case .unsupported: "unsupported"
        default: nil
        }
    }

    // MARK: CBCentralManagerDelegate (delegate calls arrive on the main queue: `queue: nil`)

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            // Activity log: changes only, never the first report.
            if bluetooth != .unknown, bluetooth != central.state, let detail = Self.name(central.state) { try? local.record(.bluetooth, detail: detail) }
            bluetooth = central.state
            if scanning && central.state == .poweredOn { central.scanForPeripherals(withServices: [Self.service]) }
            if central.state != .poweredOn { connected = false }
            evaluate()
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        MainActor.assumeIsolated {
            let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []).first { $0.identifier == local.heartRateSensor }
            restored?.delegate = self
            peripheral = restored
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated {
            let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? "Heart-rate sensor"
            if !discovered.contains(where: { $0.id == peripheral.identifier }) { discovered.append(Sensor(id: peripheral.identifier, name: name)) }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated {
            connected = true
            try? local.record(.heartRate, detail: "connected")
            peripheral.discoverServices([Self.service])
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            // Lost while still wanted (out of range, strap off): logged, then a new pending connect.
            if connected && shouldCollect { try? local.record(.heartRate, detail: "lost") }
            connected = false; evaluate()
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated { connected = false; evaluate() }
    }

    // MARK: CBPeripheralDelegate

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated {
            for service in peripheral.services ?? [] where service.uuid == Self.service { peripheral.discoverCharacteristics([Self.measurement], for: service) }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        MainActor.assumeIsolated {
            for c in service.characteristics ?? [] where c.uuid == Self.measurement { peripheral.setNotifyValue(true, for: c) }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            guard characteristic.uuid == Self.measurement, let data = characteristic.value else { return }
            record(data)
        }
    }

    private func record(_ data: Data) {
        guard shouldCollect else { return evaluate() }
        let now = CompanionRepository.now()
        guard let reading = HeartRateMeasurement.parse(data), policy.accept(contact: reading.contact, at: now) else { return }
        lastBpm = reading.bpm; lastReadingAt = Date()
        do {
            if try local.enqueueHeartRate(HeartRateSample(id: UUID().uuidString, at: now, bpm: reading.bpm, grants: recipients(at: now))) {
                // This sample filled the queue (#679): say why, then let go (shouldCollect is false at the cap).
                local.message = HeartRateQueueFullError().localizedDescription
                return evaluate()
            }
        } catch {
            // Stops visibly: shouldCollect is false at the cap, and the message says why.
            local.message = error is HeartRateQueueFullError ? error.localizedDescription : "Could not save heart rate on this phone."
            return evaluate()
        }
        if Date().timeIntervalSince(lastSyncAttempt) >= 15 {
            lastSyncAttempt = Date()
            Task { try? await repository.sync() }
        }
    }
}
