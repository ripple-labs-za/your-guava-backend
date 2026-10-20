const path = require('path');
const fs = require('fs');
const { previewBuffer } = require('../../src/services/ingestion.service');
const { parseBuffer, normaliseHeader, parserLimits } = require('../../src/services/parser.service');
const { measureBudget } = require('../helpers/budget');

const LF = String.fromCharCode(10);
const MAPPING = { date: 'Date', items: 'Items', total: 'Total' };
const TEN_MB_LINE = 10 * 1024 * 1024 - 64;
// A header, then one line that is nothing but separators: the shape that made
// csv-parser build a row object with one key per separator.
const singleLine = (bytes) => Buffer.concat([Buffer.from(`Date,Items,Total${LF}`), Buffer.alloc(bytes, ',')]);
const columnLimitMessage = () => `File exceeds the ${parserLimits().maxColumns} column limit`;
const report = (label, outcome) =>
  console.log(`${label}: ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB`);

describe('CSV reader limits', () => {
  it('caps a header before anything reads it', () => {
    expect(normaliseHeader('a'.repeat(5000))).toHaveLength(200);
    expect(normaliseHeader('﻿  Receipt  ')).toBe('Receipt');
    expect(normaliseHeader('', 3)).toBe('Column 4');
  });

  it('[budget] clips a long header in preview, so no check downstream reads more than 200 characters', async () => {
    const header = `a@${'.'.repeat(120_000)}@`; // under the 128 KB line cap, so it is read, then clipped
    const outcome = await measureBudget(() => previewBuffer(Buffer.from(`${header},Total${LF}1,2${LF}`), 'csv'));
    expect(outcome.error).toBeUndefined();
    expect(outcome.result.headers[0]).toHaveLength(200);
    expect(outcome.elapsedMs).toBeLessThan(200);
  });

  it('refuses a data row wider than the column limit in preview, exactly as parse does', async () => {
    const buffer = Buffer.from(`Date,Items,Total${LF}${','.repeat(500)}${LF}`);
    const expected = { statusCode: 400, message: columnLimitMessage() };
    await expect(previewBuffer(buffer, 'csv')).rejects.toMatchObject(expected);
    await expect(parseBuffer(buffer, { columnMapping: MAPPING, fileExt: 'csv' })).rejects.toMatchObject(expected);
  });

  it('refuses a header row wider than the column limit at confirm', async () => {
    const headers = Array.from({ length: 300 }, (_, index) => `H${index}`).join(',');
    await expect(parseBuffer(Buffer.from(`${headers}${LF}`), {
      columnMapping: { date: 'H0', items: 'H1', total: 'H2' }, fileExt: 'csv',
    })).rejects.toMatchObject({ statusCode: 400, message: columnLimitMessage() });
  });

  it('[budget] refuses the widest line under the byte cap in under 1 s and 50 MB', async () => {
    const outcome = await measureBudget(() => previewBuffer(singleLine(parserLimits().maxRowBytes - 1), 'csv'));
    report('widest line under the cap', outcome);
    expect(outcome.error).toMatchObject({ statusCode: 400, message: columnLimitMessage() });
    expect(outcome.elapsedMs).toBeLessThan(1000);
    expect(outcome.heapGrowthMb).toBeLessThan(50);
  });

  it('[budget] refuses a 10 MB single-line CSV in preview in under 1 s and 50 MB', async () => {
    const outcome = await measureBudget(() => previewBuffer(singleLine(TEN_MB_LINE), 'csv'));
    report('preview 10 MB line', outcome);
    expect(outcome.error).toMatchObject({ statusCode: 400, code: 'CSV_ROW_TOO_LONG' });
    expect(outcome.elapsedMs).toBeLessThan(1000);
    expect(outcome.heapGrowthMb).toBeLessThan(50);
  });

  it('[budget] refuses the same file at confirm as a 400, not a 500', async () => {
    const outcome = await measureBudget(() => parseBuffer(singleLine(TEN_MB_LINE), { columnMapping: MAPPING, fileExt: 'csv' }));
    report('parse 10 MB line', outcome);
    expect(outcome.error).toMatchObject({ statusCode: 400, code: 'CSV_ROW_TOO_LONG' });
    expect(outcome.elapsedMs).toBeLessThan(1000);
    expect(outcome.heapGrowthMb).toBeLessThan(50);
  });

  it('still reads an ordinary export exactly as before', async () => {
    const buffer = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test-transactions.csv'));
    const preview = await previewBuffer(buffer, 'csv');
    expect(preview.headers).toEqual(expect.arrayContaining(['Receipt', 'Date', 'Items']));
    expect(preview.sampleRows.length).toBeGreaterThan(0);
  });
});
