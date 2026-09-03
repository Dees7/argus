import * as fs from 'fs';

/**
 * Minimal reader for VS Code's `state.vscdb` — the SQLite file behind
 * `ExtensionContext.globalState`.
 *
 * The extension API only hands an extension its *own* global state, so the one
 * thing we want from Claude Code's state (which sessions the user archived)
 * cannot be asked for through VS Code. It has to be read out of the file, and
 * shipping a native SQLite binding for a single lookup is out of proportion:
 * every VS Code build would need a matching prebuilt. So we walk the b-tree
 * ourselves — the file format is stable and documented, and one lookup touches
 * only a handful of 4 KB pages.
 *
 * Read-only and side-effect free: the file is opened for reading, never
 * written, and never locked. VS Code keeps this database in rollback-journal
 * mode, so committed writes are always in the main file — no WAL to replay.
 */

/** How far a lookup may wander before we call the file corrupt and give up. */
const MAX_PAGES_VISITED = 4096;

interface StateDb {
  fd: number;
  pageSize: number;
  /** Page bytes usable by the b-tree — the tail reserved region is not. */
  usableSize: number;
}

/** SQLite's variable-length integer: 7 bits per byte, big-endian, up to 9 bytes. */
function readVarint(buf: Buffer, offset: number): { value: number; size: number } {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = buf[offset + i];
    if (byte === undefined) {
      throw new Error('truncated varint');
    }
    if (i === 7) {
      // The 9th byte contributes all 8 of its bits, not 7.
      return { value: value * 256 + byte, size: 9 };
    }
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return { value, size: i + 1 };
    }
  }
  throw new Error('unreachable');
}

function readPage(db: StateDb, pageNumber: number): Buffer {
  const buf = Buffer.alloc(db.pageSize);
  const read = fs.readSync(db.fd, buf, 0, db.pageSize, (pageNumber - 1) * db.pageSize);
  if (read < db.pageSize) {
    throw new Error(`short read on page ${pageNumber}`);
  }
  return buf;
}

/**
 * One table-leaf cell: the part of its record stored on this page, plus a way
 * to get the whole thing.
 *
 * The split matters for what this reader reads. `ItemTable` is every
 * extension's global state in one table, and finding our row means walking
 * past everyone else's. Their keys have to be compared — those are just names,
 * and they live at the start of the record — but their *values* never have to
 * be touched, and some of them are megabytes of unrelated data. So the scan
 * stays on the local bytes, and `readFull` (which follows the overflow chain
 * onto further pages) is called only for the row that matched.
 */
interface LeafCell {
  local: Buffer;
  readFull: () => Buffer;
}

function readCell(db: StateDb, page: Buffer, cellOffset: number): LeafCell {
  const { value: payloadSize, size: sizeLen } = readVarint(page, cellOffset);
  const { size: rowidLen } = readVarint(page, cellOffset + sizeLen);
  const headerLen = sizeLen + rowidLen;

  // Spill thresholds, straight out of the file-format spec: a payload longer
  // than maxLocal keeps `localSize` bytes here and the rest on overflow pages.
  const maxLocal = db.usableSize - 35;
  const minLocal = Math.floor(((db.usableSize - 12) * 32) / 255) - 23;
  let localSize = payloadSize;
  if (payloadSize > maxLocal) {
    const k = minLocal + ((payloadSize - minLocal) % (db.usableSize - 4));
    localSize = k <= maxLocal ? k : minLocal;
  }

  const start = cellOffset + headerLen;
  const local = page.subarray(start, start + localSize);
  if (payloadSize <= localSize) {
    return { local, readFull: () => local };
  }

  return {
    local,
    readFull: () => {
      const chunks = [local];
      let remaining = payloadSize - localSize;
      // First 4 bytes of each overflow page point at the next; 0 ends the chain.
      let next = page.readUInt32BE(start + localSize);
      let visited = 0;
      while (remaining > 0 && next !== 0) {
        if (++visited > MAX_PAGES_VISITED) {
          throw new Error('overflow chain too long');
        }
        const overflow = readPage(db, next);
        const take = Math.min(remaining, db.usableSize - 4);
        chunks.push(overflow.subarray(4, 4 + take));
        remaining -= take;
        next = overflow.readUInt32BE(0);
      }
      return Buffer.concat(chunks);
    },
  };
}

/**
 * Column values of one record. Text and blobs stay raw; callers decode them.
 *
 * Decoding stops at the end of `payload` rather than failing, so a record whose
 * tail sits on overflow pages still yields the columns that are present — which
 * for both tables here is every column the lookup needs.
 */
function decodeRecord(payload: Buffer): (Buffer | number | null)[] {
  const { value: headerSize, size: headerSizeLen } = readVarint(payload, 0);
  const columns: (Buffer | number | null)[] = [];

  let headerAt = headerSizeLen;
  let bodyAt = headerSize;

  const fits = (width: number) => bodyAt + width <= payload.length;

  while (headerAt < Math.min(headerSize, payload.length)) {
    const { value: serialType, size } = readVarint(payload, headerAt);
    headerAt += size;

    // Serial types, per the spec: 0 null, 1-6 integers of growing width,
    // 7 float, 8/9 the constants 0 and 1, then blobs (even) and text (odd).
    if (serialType === 0) {
      columns.push(null);
    } else if (serialType >= 1 && serialType <= 6) {
      const width = [0, 1, 2, 3, 4, 6, 8][serialType];
      if (!fits(width)) {
        break;
      }
      columns.push(Number(payload.readIntBE(bodyAt, width)));
      bodyAt += width;
    } else if (serialType === 7) {
      if (!fits(8)) {
        break;
      }
      columns.push(payload.readDoubleBE(bodyAt));
      bodyAt += 8;
    } else if (serialType === 8 || serialType === 9) {
      columns.push(serialType - 8);
    } else if (serialType >= 12) {
      const length = Math.floor((serialType - (serialType % 2 === 0 ? 12 : 13)) / 2);
      if (!fits(length)) {
        break;
      }
      columns.push(payload.subarray(bodyAt, bodyAt + length));
      bodyAt += length;
    } else {
      throw new Error(`unsupported serial type ${serialType}`);
    }
  }

  return columns;
}

/**
 * Walk one table b-tree, handing each row's cell to `visit`. Stops as soon as
 * `visit` returns a value, so a lookup reads only the pages it needs to.
 */
function scanTable<T>(
  db: StateDb,
  rootPage: number,
  visit: (cell: LeafCell) => T | undefined
): T | undefined {
  const queue: number[] = [rootPage];
  let visited = 0;

  while (queue.length > 0) {
    const pageNumber = queue.shift() as number;
    if (++visited > MAX_PAGES_VISITED) {
      throw new Error('b-tree too large');
    }

    const page = readPage(db, pageNumber);
    // Page 1 shares its page with the 100-byte database header.
    const base = pageNumber === 1 ? 100 : 0;
    const pageType = page[base];
    const cellCount = page.readUInt16BE(base + 3);
    const isInterior = pageType === 0x05;
    if (!isInterior && pageType !== 0x0d) {
      continue; // Not a table page — nothing this reader knows how to use.
    }

    const cellPointers = base + (isInterior ? 12 : 8);
    for (let i = 0; i < cellCount; i++) {
      const cellOffset = page.readUInt16BE(cellPointers + i * 2);
      if (isInterior) {
        queue.push(page.readUInt32BE(cellOffset));
        continue;
      }
      const found = visit(readCell(db, page, cellOffset));
      if (found !== undefined) {
        return found;
      }
    }

    if (isInterior) {
      queue.push(page.readUInt32BE(base + 8)); // Right-most child.
    }
  }

  return undefined;
}

/** Root page of a named table, from the `sqlite_master` table on page 1. */
function findTableRoot(db: StateDb, tableName: string): number | undefined {
  return scanTable(db, 1, cell => {
    // sqlite_master columns: type, name, tbl_name, rootpage, sql. Only the SQL
    // text can be long enough to spill, and it comes last, so the local bytes
    // always carry the four columns this needs.
    const columns = decodeRecord(cell.local);
    const type = columns[0];
    const name = columns[1];
    const rootPage = columns[3];
    if (
      Buffer.isBuffer(type) &&
      type.toString('utf8') === 'table' &&
      Buffer.isBuffer(name) &&
      name.toString('utf8') === tableName &&
      typeof rootPage === 'number'
    ) {
      return rootPage;
    }
    return undefined;
  });
}

/**
 * Value stored under `key` in the `ItemTable` of a VS Code state database, or
 * `null` when the file, the table or the key is missing. Never throws: a
 * malformed or half-written database just means we don't know, and the caller
 * degrades to showing nothing rather than failing.
 */
export function readStateDbItem(dbPath: string, key: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dbPath, 'r');

    const header = Buffer.alloc(100);
    if (fs.readSync(fd, header, 0, 100, 0) < 100) {
      return null;
    }
    if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
      return null;
    }

    // Page size is stored as a 16-bit value, where 1 stands for 64 KB.
    const rawPageSize = header.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const db: StateDb = { fd, pageSize, usableSize: pageSize - header[20] };

    const root = findTableRoot(db, 'ItemTable');
    if (root === undefined) {
      return null;
    }

    const value = scanTable(db, root, cell => {
      // Compare on the local bytes only. The key is the first column and is a
      // short name, so it is always there; every other extension's value stays
      // on disk, unread.
      const rowKey = decodeRecord(cell.local)[0];
      if (!Buffer.isBuffer(rowKey) || rowKey.toString('utf8') !== key) {
        return undefined;
      }
      const rowValue = decodeRecord(cell.readFull())[1];
      return Buffer.isBuffer(rowValue) ? rowValue.toString('utf8') : '';
    });

    return value ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do about a failed close on a read-only handle.
      }
    }
  }
}
