import CryptoKit
import SwiftUI
import UIKit

/// Catalogue images: memory, then `Caches/pas-images/<sha256(url)>`, then the credential-free `PublicFetch`.
/// Only a `200` of at most 2 MB that `UIImage` decodes is kept (the cap in `listing-images.cjs`).
actor ImageCache {
    static let shared = ImageCache()
    static let maxBytes = 2_000_000
    private let memory = NSCache<NSURL, UIImage>()
    private let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("pas-images", isDirectory: true)

    nonisolated func cached(_ url: URL) -> UIImage? { memory.object(forKey: url as NSURL) }

    func image(_ url: URL) async -> UIImage? {
        if let image = memory.object(forKey: url as NSURL) { return image }
        let file = directory.appendingPathComponent(SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined())
        if let data = try? Data(contentsOf: file), let image = UIImage(data: data) {
            memory.setObject(image, forKey: url as NSURL)
            return image
        }
        guard let (data, response) = try? await PublicFetch.shared.get(url), response.statusCode == 200,
              data.count <= Self.maxBytes, let image = UIImage(data: data) else { return nil }
        memory.setObject(image, forKey: url as NSURL)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
        return image
    }
}

/// A remote image over a placeholder that shows while loading, offline and after a failure.
struct RemoteImage<Placeholder: View>: View {
    let url: URL?
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            placeholder()
            if let image { Image(uiImage: image).resizable().scaledToFill().transition(.opacity) }
        }
        .task(id: url) {
            guard let url else { image = nil; return }
            if let hit = ImageCache.shared.cached(url) { image = hit; return }
            let loaded = await ImageCache.shared.image(url)
            withAnimation(.easeOut(duration: 0.2)) { image = loaded }
        }
    }
}

/// The app icon: the catalogue image when there is one, always over the emoji tile on `iconBg`.
struct AppIcon: View {
    let app: CatalogueApp
    let size: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
        RemoteImage(url: app.iconUrl) {
            shape.fill(app.tileColor)
                .overlay { Text(app.glyph).font(.system(size: size * 0.52)).minimumScaleFactor(0.5).lineLimit(1) }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay { shape.strokeBorder(.primary.opacity(0.08), lineWidth: 0.5) }
        .accessibilityHidden(true)
    }
}
