import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('FinnTrack API', () => {
	describe('GET /health', () => {
		it('returns health status (unit style)', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/health');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json() as { ok: boolean; service: string };
			expect(data.ok).toBe(true);
			expect(data.service).toBe('finntrack-api');
		});

		it('returns health status (integration style)', async () => {
			const request = new Request('http://example.com/health');
			const response = await SELF.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json() as { ok: boolean; service: string };
			expect(data.ok).toBe(true);
			expect(data.service).toBe('finntrack-api');
		});
	});

	describe('OPTIONS (CORS preflight)', () => {
		it('returns 204 with CORS headers', async () => {
			const request = new Request('http://example.com/track', { method: 'OPTIONS' });
			const response = await SELF.fetch(request);

			expect(response.status).toBe(204);
			expect(response.headers.get('access-control-allow-origin')).toBe('*');
			expect(response.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
		});
	});

	describe('POST /track', () => {
		it('rejects missing raceId', async () => {
			const request = new Request('http://example.com/track', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ boatId: 'boat1', lat: 60.0, lon: 24.0 }),
			});
			const response = await SELF.fetch(request);

			expect(response.status).toBe(400);
			const data = await response.json() as { ok: boolean; error: string };
			expect(data.ok).toBe(false);
			expect(data.error).toContain('raceId');
		});

		it('rejects invalid lat/lon', async () => {
			const request = new Request('http://example.com/track', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ raceId: 'race1', boatId: 'boat1', lat: 'invalid', lon: 24.0 }),
			});
			const response = await SELF.fetch(request);

			expect(response.status).toBe(400);
			const data = await response.json() as { ok: boolean; error: string };
			expect(data.ok).toBe(false);
			expect(data.error).toContain('lat/lon');
		});
	});

	describe('GET /replay', () => {
		it('rejects missing raceId', async () => {
			const request = new Request('http://example.com/replay');
			const response = await SELF.fetch(request);

			expect(response.status).toBe(400);
			const data = await response.json() as { ok: boolean; error: string };
			expect(data.ok).toBe(false);
			expect(data.error).toContain('raceId');
		});
	});

	describe('GET /live', () => {
		it('rejects non-WebSocket requests', async () => {
			const request = new Request('http://example.com/live?raceId=test');
			const response = await SELF.fetch(request);

			expect(response.status).toBe(400);
			const data = await response.json() as { ok: boolean; error: string };
			expect(data.ok).toBe(false);
			expect(data.error).toContain('WebSocket');
		});
	});

	describe('404 handling', () => {
		it('returns 404 for unknown routes', async () => {
			const request = new Request('http://example.com/unknown');
			const response = await SELF.fetch(request);

			expect(response.status).toBe(404);
		});
	});
});
