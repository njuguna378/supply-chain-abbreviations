import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import test from 'node:test';
import { serializeWorkbook } from '../lib/store.js';
import abbreviationsHandler from '../api/abbreviations.js';
import suggestionsHandler from '../api/suggestions.js';

test('Vercel APIs expose the dictionary publicly and protect moderation/admin writes', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { kid: 'test-admin-key', use: 'sig', alg: 'RS256' });

    process.env.FIREBASE_PROJECT_ID = 'test-firebase-project';
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.GITHUB_OWNER = 'test-owner';
    process.env.GITHUB_REPO = 'test-repo';
    process.env.GITHUB_BRANCH = 'main';
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.WORKBOOK_PATH = 'data/abbreviations.xlsx';

    const workbook = serializeWorkbook([
        { id: 'LMIS', abbr: 'LMIS', definition: 'Logistics Management Information System', meaning: '' }
    ], []);
    let encodedWorkbook = workbook.toString('base64');
    let workbookSha = 'initial-sha';
    const previousFetch = globalThis.fetch;
    const previousConsoleError = console.error;
    console.error = () => {};

    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        if (url.hostname === 'www.googleapis.com') {
            return new Response(JSON.stringify({ keys: [jwk] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
            });
        }
        if (url.hostname !== 'api.github.com') {
            throw new Error(`Unexpected test request: ${url.href}`);
        }
        if (options.method === 'PUT') {
            const payload = JSON.parse(options.body);
            encodedWorkbook = payload.content;
            workbookSha = 'updated-sha';
            return new Response(JSON.stringify({ sha: workbookSha }), { status: 200 });
        }
        return new Response(JSON.stringify({
            sha: workbookSha,
            content: encodedWorkbook
        }), { status: 200 });
    };

    async function adminToken(email = 'admin@example.com', provider = 'google.com') {
        return new SignJWT({
            email,
            email_verified: true,
            user_id: 'admin-user-id',
            firebase: { sign_in_provider: provider }
        })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-admin-key' })
            .setIssuer(`https://securetoken.google.com/${process.env.FIREBASE_PROJECT_ID}`)
            .setAudience(process.env.FIREBASE_PROJECT_ID)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
    }

    function responseRecorder() {
        return {
            statusCode: 200,
            headers: {},
            status(code) { this.statusCode = code; return this; },
            setHeader(name, value) { this.headers[name] = value; },
            json(body) { this.body = body; return this; }
        };
    }

    async function call(handler, method, body, token) {
        const res = responseRecorder();
        await handler({
            method,
            body,
            headers: token ? { authorization: `Bearer ${token}` } : {}
        }, res);
        return res;
    }

    try {
        const publicRead = await call(abbreviationsHandler, 'GET');
        assert.equal(publicRead.statusCode, 200);
        assert.equal(publicRead.body.items[0].abbr, 'LMIS');

        const rejectedAdminRead = await call(suggestionsHandler, 'GET');
        assert.equal(rejectedAdminRead.statusCode, 401);

        const suggestion = await call(suggestionsHandler, 'POST', {
            abbr: 'CHW',
            definition: 'Community Health Worker'
        });
        assert.equal(suggestion.statusCode, 201);

        const unauthorizedSuggestionRead = await call(suggestionsHandler, 'GET', undefined, await adminToken('other@example.com'));
        assert.equal(unauthorizedSuggestionRead.statusCode, 403);
        const nonGoogleSignIn = await call(suggestionsHandler, 'GET', undefined, await adminToken('admin@example.com', 'password'));
        assert.equal(nonGoogleSignIn.statusCode, 403);

        const token = await adminToken();
        const pending = await call(suggestionsHandler, 'GET', undefined, token);
        assert.equal(pending.statusCode, 200);
        assert.equal(pending.body.items.length, 1);
        assert.equal(pending.body.items[0].abbr, 'CHW');

        const approval = await call(suggestionsHandler, 'PATCH', {
            id: pending.body.items[0].id,
            action: 'approve'
        }, token);
        assert.equal(approval.statusCode, 200);

        const updatedDictionary = await call(abbreviationsHandler, 'GET');
        assert.deepEqual(updatedDictionary.body.items.map(item => item.abbr), ['CHW', 'LMIS']);
        const reviewed = await call(suggestionsHandler, 'GET', undefined, token);
        assert.deepEqual(reviewed.body.items, []);
    } finally {
        globalThis.fetch = previousFetch;
        console.error = previousConsoleError;
    }
});
