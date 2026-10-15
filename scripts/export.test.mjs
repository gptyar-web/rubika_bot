import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createXLSX } from '../assets/js/exporters.js';

const execute = promisify(execFile);
const decode = new TextDecoder();
function entries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const files = new Map(); let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'Test reader expects stored ZIP entries.');
    const size = view.getUint32(offset + 18, true); const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true);
    const name = decode.decode(bytes.slice(offset + 30, offset + 30 + nameLength)); const begin = offset + 30 + nameLength + extraLength;
    files.set(name, decode.decode(bytes.slice(begin, begin + size))); offset = begin + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, 'ZIP central directory follows data.');
  assert.equal(view.getUint32(bytes.byteLength - 22, true), 0x06054b50, 'ZIP archive has an end directory record.');
  assert.equal(view.getUint16(bytes.byteLength - 12, true), files.size);
  return files;
}

test('native XLSX produces the required OOXML relationships, RTL worksheet and union object headers', () => {
  const files = entries(createXLSX([{ name: 'علی', count: 2 }, { extra: true, name: 'مینا' }], 'گزارش [آزمون]'));
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']);
  assert.match(files.get('[Content_Types].xml'), /spreadsheetml\.sheet\.main\+xml/);
  assert.match(files.get('_rels/.rels'), /Target="xl\/workbook.xml"/);
  assert.match(files.get('xl/_rels/workbook.xml.rels'), /Target="worksheets\/sheet1.xml"/);
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /rightToLeft="1"/); assert.match(sheet, /r="A1" t="inlineStr"[^]*>name<\/t>/);
  assert.match(sheet, /r="B2"><v>2<\/v>/); assert.match(sheet, /r="C3" t="b"><v>1<\/v>/);
  assert.doesNotMatch(files.get('xl/workbook.xml'), /\[آزمون\]/);
});

test('formula-looking content remains literal text and forbidden XML characters are removed', () => {
  const files = entries(createXLSX([['=HYPERLINK("https://example.com")', '+SUM(A1)', '@evil', ' & < > " \' ', 'الف\u0000\u0001\ud800\uffff😀', new Date('2026-10-15T00:00:00Z'), { name: 'nested' }]]));
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert.doesNotMatch(sheet, /<f(?:[\s>])/); assert.match(sheet, /=HYPERLINK\(&quot;https:\/\/example.com&quot;\)/);
  assert.match(sheet, /&amp; &lt; &gt; &quot; &apos;/); assert.match(sheet, /الف😀/);
  assert.doesNotMatch(sheet, /[\u0000\u0001\ud800\uffff]/u); assert.match(sheet, /2026-10-15T00:00:00.000Z/);
  assert.match(sheet, /&quot;name&quot;:&quot;nested&quot;/);
});

test('XLSX rejects unsupported dimensions, mixed rows, cyclic objects, invalid dates and oversized cells', () => {
  for (const value of [null, {}, [[1], { a: 1 }], [null], [[new Date('invalid')]], [['x'.repeat(32768)]], [Array(16385).fill(1)]]) assert.throws(() => createXLSX(value));
  const cycle = {}; cycle.self = cycle; assert.throws(() => createXLSX([[cycle]]));
  assert.equal(entries(createXLSX([])).size, 5); assert.match(entries(createXLSX([[null, undefined, 0, false]])).get('xl/worksheets/sheet1.xml'), /r="C1"><v>0<\/v>/);
});

test('independent unzip verifies every archive checksum and extracts escaped Persian OOXML', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rubika-xlsx-test-'));
  try {
    const filename = path.join(directory, 'report.xlsx'); await writeFile(filename, createXLSX([{ نام: 'علی & مینا', پیام: '=1+1' }]));
    let result;
    try { result = await execute('unzip', ['-t', filename]); } catch (error) { if (error.code === 'ENOENT') { t.skip('unzip is not installed; browser DOMParser checks still validate all OOXML.'); return; } throw error; }
    assert.match(result.stdout, /No errors detected/);
    const xml = await execute('unzip', ['-p', filename, 'xl/worksheets/sheet1.xml']); assert.match(xml.stdout, /علی &amp; مینا/); assert.doesNotMatch(xml.stdout, /<f[\s>]/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
