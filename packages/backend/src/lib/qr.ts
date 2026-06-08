/**
 * Minimal QR code SVG generator — byte mode, EC level L, versions 1-10.
 * Pure TypeScript, no dependencies. Generates compact SVG strings.
 */

// Version capacities for byte mode, EC level L (data codewords)
const VERSION_DATA: [number, number, number][] = [
  // [totalCodewords, ecCodewordsPerBlock, numBlocks]
  [19, 7, 1],    // V1: 26 total, 19 data, 7 EC
  [34, 10, 1],   // V2: 44 total, 34 data, 10 EC
  [55, 15, 1],   // V3: 70 total, 55 data, 15 EC
  [80, 20, 1],   // V4: 100 total, 80 data, 20 EC
  [108, 26, 1],  // V5: 134 total, 108 data, 26 EC
  [136, 18, 2],  // V6: 172 total, 136 data, 18 EC each
  [156, 20, 2],  // V7: 196 total, 156 data, 20 EC each
  [194, 24, 2],  // V8: 242 total, 194 data, 24 EC each
  [232, 30, 2],  // V9: 292 total, 232 data, 30 EC each
  [271, 18, 4],  // V10: 346 total, 271 data, 18 EC each
];

// Alignment pattern positions per version (V2+)
const ALIGN_POS: number[][] = [
  [],        // V1
  [6, 18],   // V2
  [6, 22],   // V3
  [6, 26],   // V4
  [6, 30],   // V5
  [6, 34],   // V6
  [6, 22, 38], // V7
  [6, 24, 42], // V8
  [6, 26, 46], // V9
  [6, 28, 52], // V10
];

// GF(256) log and exp tables (primitive poly 0x11d)
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
(() => {
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    v = (v << 1) ^ (v >= 128 ? 0x11d : 0);
  }
  EXP[255] = EXP[0]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a]! + LOG[b]!) % 255]!;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  // Generate polynomial
  const gen = new Uint8Array(ecCount + 1);
  gen[0] = 1;
  for (let i = 0; i < ecCount; i++) {
    for (let j = ecCount; j > 0; j--) {
      gen[j] = gen[j]! ^ gfMul(gen[j - 1]!, EXP[i]!);
    }
  }
  // Polynomial division
  const result = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const coef = data[i]! ^ result[0]!;
    result.copyWithin(0, 1);
    result[ecCount - 1] = 0;
    if (coef !== 0) {
      for (let j = 0; j < ecCount; j++) {
        result[j] = result[j]! ^ gfMul(gen[j + 1]!, coef);
      }
    }
  }
  return result;
}

function selectVersion(dataLen: number): number {
  for (let v = 0; v < VERSION_DATA.length; v++) {
    // Byte mode overhead: 4 (mode) + charCountBits + data*8 + terminator(up to 4)
    const charCountBits = v < 9 ? 8 : 16;
    const available = VERSION_DATA[v]![0] * 8;
    const needed = 4 + charCountBits + dataLen * 8;
    if (needed <= available) return v + 1;
  }
  throw new Error('Data too long for QR versions 1-10');
}

function encodeData(data: Uint8Array, version: number): Uint8Array {
  const vIdx = version - 1;
  const [totalData] = VERSION_DATA[vIdx]!;
  const charCountBits = version < 10 ? 8 : 16;

  // Build bit stream
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode indicator
  pushBits(data.length, charCountBits);
  for (const b of data) pushBits(b, 8);

  // Terminator (up to 4 bits)
  const remaining = totalData * 8 - bits.length;
  pushBits(0, Math.min(4, remaining));

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad codewords
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < totalData * 8) {
    pushBits(padBytes[padIdx % 2]!, 8);
    padIdx++;
  }

  // Convert to bytes
  const codewords = new Uint8Array(totalData);
  for (let i = 0; i < totalData; i++) {
    codewords[i] = (bits[i * 8]! << 7) | (bits[i * 8 + 1]! << 6) |
      (bits[i * 8 + 2]! << 5) | (bits[i * 8 + 3]! << 4) |
      (bits[i * 8 + 4]! << 3) | (bits[i * 8 + 5]! << 2) |
      (bits[i * 8 + 6]! << 1) | bits[i * 8 + 7]!;
  }
  return codewords;
}

function buildMatrix(version: number, dataCodewords: Uint8Array): boolean[][] {
  const vIdx = version - 1;
  const [totalData, ecPerBlock, numBlocks] = VERSION_DATA[vIdx]!;
  const size = 17 + version * 4;

  // Generate EC codewords
  const blockSize = Math.floor(totalData / numBlocks);
  const longBlocks = totalData - blockSize * numBlocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const bLen = blockSize + (b >= numBlocks - longBlocks ? 1 : 0);
    const block = dataCodewords.slice(offset, offset + bLen);
    offset += bLen;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  // Interleave
  const allBytes: number[] = [];
  const maxDataLen = blockSize + (longBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) allBytes.push(block[i]!);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) allBytes.push(block[i]!);
  }

  // Create matrix (null = unset, true = dark, false = light)
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );

  const setModule = (r: number, c: number, dark: boolean, res = true) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r]![c] = dark;
      if (res) reserved[r]![c] = true;
    }
  };

  // Finder patterns (7x7 + separator)
  const drawFinder = (row: number, col: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr, c = col + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setModule(r, c, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const alignPos = ALIGN_POS[vIdx]!;
  for (const r of alignPos) {
    for (const co of alignPos) {
      // Skip if overlapping finder
      if (r <= 8 && co <= 8) continue;
      if (r <= 8 && co >= size - 9) continue;
      if (r >= size - 9 && co <= 8) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setModule(r + dr, co + dc, dark);
        }
      }
    }
  }

  // Reserve format info areas
  for (let i = 0; i < 8; i++) {
    setModule(8, i, false); setModule(8, size - 1 - i, false);
    setModule(i, 8, false); setModule(size - 1 - i, 8, false);
  }
  setModule(8, 8, false);
  // Dark module
  setModule(size - 8, 8, true);

  // Version info (V7+)
  if (version >= 7) {
    const vInfo = VERSION_INFO[version - 7]!;
    for (let i = 0; i < 18; i++) {
      const dark = ((vInfo >> i) & 1) === 1;
      const r = Math.floor(i / 3), c = size - 11 + (i % 3);
      setModule(r, c, dark);
      setModule(c, r, dark);
    }
  }

  // Place data bits
  const bitStream: number[] = [];
  for (const byte of allBytes) {
    for (let b = 7; b >= 0; b--) bitStream.push((byte >> b) & 1);
  }

  let bitIdx = 0;
  for (let col = size - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5; // skip timing column
    for (let row = 0; row < size; row++) {
      for (let c = 0; c < 2; c++) {
        const actualCol = col - c;
        const upward = ((size - 1 - col) >> 1) % 2 === 0;
        const actualRow = upward ? size - 1 - row : row;
        if (!reserved[actualRow]![actualCol]) {
          matrix[actualRow]![actualCol] = bitIdx < bitStream.length ? bitStream[bitIdx]! === 1 : false;
          bitIdx++;
        }
      }
    }
  }

  // Apply best mask
  let bestMatrix = matrix;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const masked = matrix.map((row, r) =>
      row.map((val, c) => {
        if (reserved[r]![c]) return val!;
        return val! !== maskBit(mask, r, c);
      }),
    );
    // Write format info
    const formatBits = getFormatBits(mask);
    writeFormat(masked, size, formatBits);
    const penalty = calcPenalty(masked, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = masked;
    }
  }
  return bestMatrix as boolean[][];
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r * c) % 2 + (r * c) % 3 === 0;
    case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
    case 7: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    default: return false;
  }
}

// Format info for EC level L (indicator = 01) + mask pattern
const FORMAT_STRINGS: number[] = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function getFormatBits(mask: number): number {
  return FORMAT_STRINGS[mask]!;
}

function writeFormat(matrix: boolean[][], size: number, bits: number): void {
  // Around top-left finder
  const positions = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> (14 - i)) & 1) === 1;
    const [r, c] = positions[i]!;
    matrix[r!]![c!] = dark;
  }
  // Around top-right and bottom-left finders
  for (let i = 0; i < 8; i++) {
    const dark = ((bits >> (14 - i)) & 1) === 1;
    matrix[8]![size - 1 - i] = dark;
  }
  for (let i = 8; i < 15; i++) {
    const dark = ((bits >> (14 - i)) & 1) === 1;
    matrix[size - 15 + i]![8] = dark;
  }
}

// Version info BCH codes (V7-V10)
const VERSION_INFO = [0x07c94, 0x085bc, 0x09a99, 0x0a4d3];

function calcPenalty(matrix: boolean[][], size: number): number {
  let penalty = 0;
  // Rule 1: adjacent same-color modules in row/col
  for (let r = 0; r < size; r++) {
    let count = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r]![c] === matrix[r]![c - 1]) { count++; }
      else { if (count >= 5) penalty += count - 2; count = 1; }
    }
    if (count >= 5) penalty += count - 2;
  }
  for (let c = 0; c < size; c++) {
    let count = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r]![c] === matrix[r - 1]![c]) { count++; }
      else { if (count >= 5) penalty += count - 2; count = 1; }
    }
    if (count >= 5) penalty += count - 2;
  }
  // Rule 4: proportion of dark modules
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r]![c]) dark++;
  const percent = (dark * 100) / (size * size);
  penalty += Math.abs(Math.floor(percent / 5) * 5 - 50) * 2;
  return penalty;
}

/** Generate a QR code as an SVG string. */
export function generateQrSvg(text: string, moduleSize = 4, margin = 4): string {
  const data = new TextEncoder().encode(text);
  const version = selectVersion(data.length);
  const codewords = encodeData(data, version);
  const matrix = buildMatrix(version, codewords);
  const size = matrix.length;
  const svgSize = (size + margin * 2) * moduleSize;

  let paths = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r]![c]) {
        const x = (c + margin) * moduleSize;
        const y = (r + margin) * moduleSize;
        paths += `M${x},${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}" width="${svgSize}" height="${svgSize}"><rect width="100%" height="100%" fill="#fff"/><path d="${paths}" fill="#000"/></svg>`;
}
