export default async function handler(req, res) {
	const origin = req.headers.origin;
	const allowedOrigins = parseAllowedOrigins(process.env.CONTACT_ALLOWED_ORIGIN);
	const corsOrigin = getCorsOrigin(origin, allowedOrigins);

	if (corsOrigin) {
		res.setHeader('Access-Control-Allow-Origin', corsOrigin);
		res.setHeader('Vary', 'Origin');
	}
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		if (!corsOrigin) {
			res.status(403).json({ ok: false, error: 'Origin not allowed.' });
			return;
		}
		res.status(204).end();
		return;
	}

	if (!corsOrigin) {
		res.status(403).json({ ok: false, error: 'Origin not allowed.' });
		return;
	}

	if (req.method !== 'POST') {
		res.status(405).json({ ok: false, error: 'Method not allowed' });
		return;
	}

	try {
		const contentType = (req.headers['content-type'] || '').toLowerCase();
		const rawBody = await readRawBody(req);

		let data = {};
		if (contentType.includes('application/json')) {
			data = rawBody ? JSON.parse(rawBody) : {};
		} else if (contentType.includes('application/x-www-form-urlencoded')) {
			data = Object.fromEntries(new URLSearchParams(rawBody));
		} else if (contentType.includes('multipart/form-data')) {
			// Most browsers will send multipart/form-data when using FormData().
			// Vercel's Node runtime does not parse multipart automatically.
			// Fallback: ask the client to send urlencoded or JSON.
			res.status(400).json({ ok: false, error: 'Unsupported content type' });
			return;
		} else {
			data = Object.fromEntries(new URLSearchParams(rawBody));
		}

		const name = (data.name || '').toString().trim();
		const email = (data.email || '').toString().trim();
		const message = (data.message || '').toString().trim();
		const gotcha = (data._gotcha || '').toString().trim();

		if (gotcha) {
			res.status(200).json({ ok: true });
			return;
		}

		if (!name || !email || !message) {
			res.status(400).json({ ok: false, error: 'Please fill out all fields.' });
			return;
		}

		if (!isValidEmail(email)) {
			res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
			return;
		}

		const resendKey = process.env.RESEND_API_KEY;
		const toEmail = process.env.CONTACT_TO_EMAIL;
		const fromEmail = process.env.CONTACT_FROM_EMAIL;

		if (!resendKey || !toEmail || !fromEmail) {
			res.status(500).json({ ok: false, error: 'Server is not configured.' });
			return;
		}

		const subject = 'New message from portfolio contact form';
		const text = `Name: ${name}\nEmail: ${email}\n\n${message}`;

		const sendResponse = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${resendKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: fromEmail,
				to: toEmail,
				subject,
				text,
				replyTo: email,
			}),
		});

		if (!sendResponse.ok) {
			const providerText = await safeReadText(sendResponse);
			const providerJson = safeJsonParse(providerText);
			const providerMessage =
				(providerJson && (providerJson.message || providerJson.error || providerJson.details)) || providerText;

			let errorMessage = 'Failed to send message.';
			const providerMessageLower = String(providerMessage || '').toLowerCase();
			if (providerMessageLower.includes('verify') || providerMessageLower.includes('verified')) {
				errorMessage = 'Email sender is not verified. Check Resend domain/sender verification.';
			} else if (providerMessageLower.includes('api key') || providerMessageLower.includes('authorization')) {
				errorMessage = 'Email provider authorization failed. Check RESEND_API_KEY.';
			}

			const status = sendResponse.status >= 400 && sendResponse.status < 500 ? sendResponse.status : 502;
			res.status(status).json({
				ok: false,
				error: errorMessage,
				details: {
					status: sendResponse.status,
					provider: 'resend',
					message: providerMessage,
				},
			});
			return;
		}

		res.status(200).json({ ok: true });
	} catch (error) {
		res.status(500).json({ ok: false, error: 'Unexpected server error.' });
	}
}

function parseAllowedOrigins(value) {
	if (!value) return [];
	return value
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
}

function getCorsOrigin(origin, allowedOrigins) {
	if (allowedOrigins.length === 0) return '*';
	if (!origin) return null;
	return isOriginAllowed(origin, allowedOrigins) ? origin : null;
}

function isOriginAllowed(origin, allowedOrigins) {
	return allowedOrigins.some((allowed) => {
		if (allowed === origin) return true;
		if (allowed.startsWith('*.')) {
			const suffix = allowed.slice(1); // '.vercel.app'
			return origin.endsWith(suffix);
		}
		return false;
	});
}

function readRawBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk) => {
			data += chunk;
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

function isValidEmail(value) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function safeReadText(response) {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

function safeJsonParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
