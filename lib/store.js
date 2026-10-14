import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as XLSX from 'xlsx';

const ABBREVIATION_HEADERS = ['Acronym', 'Full Definition', 'Meaning'];
const SUGGESTION_HEADERS = ['ID', 'Acronym', 'Full Definition', 'Status', 'Submitted At'];
const MAX_ABBREVIATIONS = 10000;
const MAX_SUGGESTIONS = 5000;
const firebaseSigningKeys = createRemoteJWKSet(new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
));

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function parseRequestBody(req) {
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        throw new ApiError(400, 'The request body must contain valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'The request body must be a JSON object.');
    }
    if (Buffer.byteLength(JSON.stringify(body)) > 3 * 1024 * 1024) {
        throw new ApiError(413, 'The import is too large. Split it into smaller Excel imports.');
    }
    return body;
}

function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new ApiError(500, `Server configuration is missing ${name}.`);
    return value;
}

function githubConfig() {
    return {
        owner: requiredEnv('GITHUB_OWNER'),
        repo: requiredEnv('GITHUB_REPO'),
        branch: process.env.GITHUB_BRANCH || 'main',
        token: requiredEnv('GITHUB_TOKEN'),
        workbookPath: process.env.WORKBOOK_PATH || 'data/abbreviations.xlsx'
    };
}

export async function requireAdmin(req) {
    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer (.+)$/i);
    if (!match) throw new ApiError(401, 'Admin sign-in is required.');

    try {
        const projectId = requiredEnv('FIREBASE_PROJECT_ID');
        const { payload: decoded } = await jwtVerify(match[1], firebaseSigningKeys, {
            issuer: `https://securetoken.google.com/${projectId}`,
            audience: projectId
        });
        const adminEmail = requiredEnv('ADMIN_EMAIL').toLowerCase();
        if (!decoded.email_verified
            || decoded.email?.toLowerCase() !== adminEmail
            || decoded.firebase?.sign_in_provider !== 'google.com') {
            throw new ApiError(403, 'This Google account is not authorized to administer the dictionary.');
        }
        return decoded;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(401, 'Your admin session is invalid or expired. Sign in again.');
    }
}

async function githubRequest(path, options = {}) {
    const { owner, repo, token } = githubConfig();
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, {
        ...options,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers
        }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const status = response.status === 404
            ? 404
            : response.status === 409 || response.status === 422 ? 409 : 502;
        throw new ApiError(status, response.status === 404
            ? 'The workbook was not found in the configured GitHub repository.'
            : `GitHub storage request failed (${response.status}).`);
    }
    return result;
}

function workbookApiPath(path, branch) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
}

function createWorkbook() {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([ABBREVIATION_HEADERS]), 'Acronyms');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([SUGGESTION_HEADERS]), 'Suggestions');
    return workbook;
}

function sheetRecords(sheet, width) {
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false })
        .slice(1)
        .filter(row => row.some(value => String(value ?? '').trim()))
        .map(row => Array.from({ length: width }, (_, index) => String(row[index] ?? '').trim()));
}

export function parseWorkbook(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const abbreviationRows = sheetRecords(workbook.Sheets.Acronyms || workbook.Sheets[workbook.SheetNames[0]], 3);
    const suggestionsRows = sheetRecords(workbook.Sheets.Suggestions, 5);
    return {
        items: abbreviationRows
            .filter(([abbr, definition]) => abbr && definition)
            .map(([abbr, definition, meaning]) => ({
                id: abbr.toUpperCase(),
                abbr,
                definition,
                meaning
            })),
        suggestions: suggestionsRows
            .filter(([id, abbr, definition]) => id && abbr && definition)
            .map(([id, abbr, definition, status, createdAt]) => ({
                id,
                abbr,
                definition,
                status: status || 'pending',
                createdAt
            }))
    };
}

export function serializeWorkbook(items, suggestions) {
    const workbook = createWorkbook();
    workbook.Sheets.Acronyms = XLSX.utils.aoa_to_sheet([
        ABBREVIATION_HEADERS,
        ...items.map(item => [item.abbr, item.definition, item.meaning || ''])
    ]);
    workbook.Sheets.Suggestions = XLSX.utils.aoa_to_sheet([
        SUGGESTION_HEADERS,
        ...suggestions.map(item => [item.id, item.abbr, item.definition, item.status, item.createdAt])
    ]);
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function readWorkbook() {
    const config = githubConfig();
    const path = workbookApiPath(config.workbookPath, config.branch);
    try {
        const file = await githubRequest(path);
        const content = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
        return { ...parseWorkbook(content), sha: file.sha };
    } catch (error) {
        if (error.status === 404) {
            return { items: [], suggestions: [], sha: undefined };
        }
        throw error;
    }
}

async function writeWorkbook(items, suggestions, sha) {
    const config = githubConfig();
    const path = workbookApiPath(config.workbookPath, config.branch).split('?')[0];
    const binary = serializeWorkbook(items, suggestions);
    const body = {
        message: 'Update abbreviation workbook',
        content: binary.toString('base64'),
        branch: config.branch
    };
    if (sha) body.sha = sha;
    return githubRequest(path, { method: 'PUT', body: JSON.stringify(body) });
}

export async function mutateWorkbook(mutator) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const workbook = await readWorkbook();
        const result = await mutator(workbook);
        try {
            await writeWorkbook(workbook.items, workbook.suggestions, workbook.sha);
            return result;
        } catch (error) {
            if (error.status !== 409 || attempt === 2) throw error;
        }
    }
    throw new ApiError(409, 'The workbook changed concurrently. Please retry.');
}

export async function getWorkbookData() {
    const { items } = await readWorkbook();
    return items.sort((a, b) => a.abbr.localeCompare(b.abbr));
}

export function publicItems(items) {
    return items
        .map(({ id, abbr, definition, meaning }) => ({ id, abbr, definition, meaning }))
        .sort((a, b) => a.abbr.localeCompare(b.abbr));
}

export async function getPendingSuggestions() {
    const { suggestions } = await readWorkbook();
    return suggestions
        .filter(item => item.status === 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function validateAbbreviation(item) {
    if (!item || typeof item !== 'object') {
        throw new ApiError(400, 'An abbreviation and full definition are required.');
    }
    const abbr = String(item.abbr || '').trim().toUpperCase();
    const definition = String(item.definition || '').trim();
    const meaning = String(item.meaning || '').trim();
    if (!abbr || abbr.length > 40 || /[\u0000-\u001f]/.test(abbr)) {
        throw new ApiError(400, 'Acronyms must be between 1 and 40 characters.');
    }
    if (!definition || definition.length > 500) {
        throw new ApiError(400, 'Definitions must be between 1 and 500 characters.');
    }
    if (meaning.length > 2000) {
        throw new ApiError(400, 'Meanings must be 2000 characters or fewer.');
    }
    return { abbr, definition, meaning };
}

export { MAX_ABBREVIATIONS, MAX_SUGGESTIONS };
