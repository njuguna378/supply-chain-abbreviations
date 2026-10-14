import { mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as XLSX from 'xlsx';

const target = resolve(process.argv[2] || 'data/abbreviations.xlsx');
try {
    await access(target);
    throw new Error(`Refusing to overwrite existing workbook: ${target}`);
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Acronym', 'Full Definition', 'Meaning']
]), 'Acronyms');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['ID', 'Acronym', 'Full Definition', 'Status', 'Submitted At']
]), 'Suggestions');
await mkdir(dirname(target), { recursive: true });
XLSX.writeFile(workbook, target);
console.log(`Created Excel template: ${target}`);
