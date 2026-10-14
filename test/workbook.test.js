import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseWorkbook, serializeWorkbook, validateAbbreviation } from '../lib/store.js';

test('template contains the standard dictionary and suggestion worksheets', async () => {
    const workbook = XLSX.read(await readFile('data/abbreviations.xlsx'), { type: 'buffer' });
    assert.deepEqual(workbook.SheetNames, ['Acronyms', 'Suggestions']);
    assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets.Acronyms, { header: 1 }), [
        ['Acronym', 'Full Definition', 'Meaning']
    ]);
    assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets.Suggestions, { header: 1 }), [
        ['ID', 'Acronym', 'Full Definition', 'Status', 'Submitted At']
    ]);
});

test('workbook serialization round-trips dictionary rows and pending suggestions', () => {
    const buffer = serializeWorkbook([
        { id: 'LMIS', abbr: 'LMIS', definition: 'Logistics Management Information System', meaning: 'Supply chain context' }
    ], [
        { id: 'suggestion-1', abbr: 'CHW', definition: 'Community Health Worker', status: 'pending', createdAt: '2026-10-08T06:00:00.000Z' }
    ]);
    const result = parseWorkbook(buffer);
    assert.deepEqual(result.items, [
        { id: 'LMIS', abbr: 'LMIS', definition: 'Logistics Management Information System', meaning: 'Supply chain context' }
    ]);
    assert.deepEqual(result.suggestions, [
        { id: 'suggestion-1', abbr: 'CHW', definition: 'Community Health Worker', status: 'pending', createdAt: '2026-10-08T06:00:00.000Z' }
    ]);
});

test('abbreviation validation normalizes acronym and rejects oversized definitions', () => {
    assert.deepEqual(validateAbbreviation({
        abbr: '  lmis ',
        definition: ' Logistics Management Information System ',
        meaning: '  '
    }), {
        abbr: 'LMIS',
        definition: 'Logistics Management Information System',
        meaning: ''
    });
    assert.throws(
        () => validateAbbreviation({ abbr: 'X', definition: 'd'.repeat(501) }),
        { status: 400 }
    );
});
