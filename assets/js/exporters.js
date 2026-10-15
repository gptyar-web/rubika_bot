// Native, dependency-free OOXML export. Text cells are always inline strings,
// so a value such as =HYPERLINK(...) can never become an executable formula.
const encoder = new TextEncoder();
const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;
const MAX_CELL_LENGTH = 32767;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

function xmlText(value) {
  // XML 1.0 forbids control characters, lone surrogates and U+FFFE/U+FFFF.
  return Array.from(String(value), character => {
    const code = character.codePointAt(0);
    return (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)) ? character : '';
  }).join('');
}

function xml(value) {
  return xmlText(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function columnName(index) {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

function cell(value, reference) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  let text;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Cannot export an invalid date.');
    text = value.toISOString();
  } else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (text.length > MAX_CELL_LENGTH) throw new RangeError('Excel text cells support at most 32767 characters.');
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Workbook rows must be an array.');
  if (rows.length > MAX_ROWS) throw new RangeError('Excel supports at most 1048576 rows.');
  if (!rows.length) return [];
  if (Array.isArray(rows[0])) {
    if (rows.some(row => !Array.isArray(row))) throw new TypeError('Workbook rows must all have the same format.');
    if (rows.some(row => row.length > MAX_COLUMNS)) throw new RangeError('Excel supports at most 16384 columns.');
    return rows;
  }
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)) {
    throw new TypeError('Workbook rows must be arrays or plain objects.');
  }
  if (rows.length >= MAX_ROWS) throw new RangeError('The header and data exceed Excel\'s row limit.');
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (keys.length > MAX_COLUMNS) throw new RangeError('Excel supports at most 16384 columns.');
  return [keys, ...rows.map(row => keys.map(key => Object.prototype.hasOwnProperty.call(row, key) ? row[key] : null))];
}

function zip(files) {
  const entries = files.map(([path, contents]) => {
    const name = encoder.encode(path);
    const data = encoder.encode(contents);
    return { name, data, crc: crc32(data) };
  });
  const localSize = entries.reduce((total, entry) => total + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = entries.reduce((total, entry) => total + 46 + entry.name.length, 0);
  if (localSize + centralSize + 22 >= 0xffffffff) throw new RangeError('Workbook exceeds the supported ZIP archive size.');
  const result = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 names; stored entries, without descriptors.
    view.setUint16(offset + 12, 33, true); // DOS date: 1980-01-01.
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.name.length, true);
    result.set(entry.name, offset + 30);
    result.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  for (const entry of entries) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 14, 33, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    view.setUint32(offset + 42, entry.offset, true);
    result.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, localSize, true);
  return result;
}

export function createXLSX(rows, sheetName = 'گزارش') {
  const normalized = normalizeRows(rows);
  let name = xmlText(sheetName).replace(/[:\\/?*\[\]]/g, ' ').trim().replace(/^'+|'+$/g, '').trim().slice(0, 31);
  name = xmlText(name) || 'گزارش';
  const data = normalized.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => cell(value, `${columnName(column)}${index + 1}`)).join('')}</row>`).join('');
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zip([
    ['[Content_Types].xml', `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${declaration}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `${declaration}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"/></sheetViews><sheetData>${data}</sheetData></worksheet>`],
  ]);
}
