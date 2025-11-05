import type { APIRoute } from 'astro';
import { Resend } from 'resend';

export const prerender = false;

const resend = new Resend(process.env.RESEND_API_KEY);

// Rate limiting (in-memory store - simple implementation)
const rateLimit = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 1; // 1 order per IP per window

// Helper function to get client IP
function getClientIP(request: Request): string {
	// Try to get IP from various headers (common in serverless environments)
	const forwarded = request.headers.get('x-forwarded-for');
	if (forwarded) {
		return forwarded.split(',')[0].trim();
	}
	
	const realIP = request.headers.get('x-real-ip');
	if (realIP) {
		return realIP;
	}
	
	const cfConnectingIP = request.headers.get('cf-connecting-ip');
	if (cfConnectingIP) {
		return cfConnectingIP;
	}
	
	return 'unknown';
}

// Helper function to sanitize input
function sanitizeInput(input: string): string {
	return input
		.replace(/<[^>]*>/g, '') // Remove HTML tags
		.replace(/[<>]/g, '') // Remove remaining angle brackets
		.trim()
		.slice(0, 1000); // Limit length
}

// Helper function to check rate limit
function checkRateLimit(ip: string): { allowed: boolean; message?: string } {
	const now = Date.now();
	const record = rateLimit.get(ip);

	if (record) {
		if (now < record.resetTime) {
			if (record.count >= RATE_LIMIT_MAX) {
				const minutesLeft = Math.ceil((record.resetTime - now) / 60000);
				return {
					allowed: false,
					message: `Rate limit exceeded. Please try again in ${minutesLeft} minute(s).`,
				};
			}
			record.count++;
		} else {
			// Reset window
			rateLimit.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
		}
	} else {
		// First request from this IP
		rateLimit.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
	}

	return { allowed: true };
}

export const POST: APIRoute = async ({ request }) => {
	try {
		// Get client IP for rate limiting
		const ip = getClientIP(request);

		// Check rate limit
		const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
            return new Response(JSON.stringify({ error: rateCheck.message || 'Hai effettuato troppi ordini. Riprova più tardi.' }), {
				status: 429,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Parse form data using FormData API (works with standard Request)
		let formData;
		try {
			formData = await request.formData();
		} catch (formDataError: any) {
			console.error('FormData parsing error:', formDataError);
			const contentType = request.headers.get('content-type') || 'unknown';
            return new Response(JSON.stringify({ 
                error: 'Impossibile leggere i dati del modulo. Riprova.',
                details: `Content-Type: ${contentType}, Error: ${formDataError.message}`,
            }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Extract form fields
		const name = sanitizeInput((formData.get('name') as string) || '');
		const email = sanitizeInput((formData.get('email') as string) || '');
		const clothingType = sanitizeInput((formData.get('clothingType') as string) || '');
		const customText = sanitizeInput((formData.get('customText') as string) || '');

		// Validate required fields
        if (!name || !email || !clothingType) {
			return new Response(
                JSON.stringify({ error: 'Nome, email e tipo di abbigliamento sono obbligatori.' }),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}

		// Validate email format
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return new Response(JSON.stringify({ error: 'Formato email non valido.' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Handle image upload
		let imageBase64 = '';
		let imageMimeType = '';

		const imageFile = formData.get('image') as File | null;
		if (imageFile && imageFile.size > 0) {
			// Validate file size
            if (imageFile.size > 5 * 1024 * 1024) {
                return new Response(JSON.stringify({ error: 'L\'immagine supera il limite di 5MB.' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Validate file type
			const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
            if (!imageFile.type || !allowedTypes.includes(imageFile.type)) {
                return new Response(JSON.stringify({ error: 'Tipo di immagine non valido. Consentiti: JPEG, PNG, GIF, WebP.' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Convert file to base64
			const arrayBuffer = await imageFile.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			imageBase64 = buffer.toString('base64');
			imageMimeType = imageFile.type || 'image/png';
		}

		// Prepare email content
        const emailSubject = `Nuovo ordine Snaphalagulus da ${name}`;
		
		let emailHtml = `
            <h2>Nuovo ordine dal sito Snaphalagulus</h2>
            <p><strong>Nome:</strong> ${sanitizeInput(name)}</p>
            <p><strong>Email:</strong> ${sanitizeInput(email)}</p>
            <p><strong>Capo:</strong> ${sanitizeInput(clothingType)}</p>
            <p><strong>Testo personalizzato:</strong> ${sanitizeInput(customText) || 'Nessuno'}</p>
            <p><strong>IP:</strong> ${ip}</p>
		`;

		if (imageBase64) {
			emailHtml += `
				<img src="data:${imageMimeType};base64,${imageBase64}" style="max-width:300px; height:auto; border: 2px solid #000; margin-top: 20px;" alt="Customer uploaded image" />
			`;
		}

        // Send email via Resend
        if (!process.env.RESEND_API_KEY) {
			console.error('RESEND_API_KEY is not set');
			return new Response(JSON.stringify({ error: 'Server configuration error.' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}

        const { data, error } = await resend.emails.send({
            from: 'Snaphalagulus Ordini <onboarding@resend.dev>',
            to: ['snaphalagus@gmail.com'],
            replyTo: email,
            subject: emailSubject,
            html: emailHtml,
        });

		if (error) {
			console.error('Resend API error:', error);
			// Return more detailed error information
            const errorMessage = error.message || 'Invio email fallito. Riprova più tardi.';
			return new Response(JSON.stringify({ 
				error: errorMessage,
				details: error.name || error,
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}

        return new Response(JSON.stringify({ success: true, message: 'Ordine inviato con successo!' }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error: any) {
		console.error('Order processing error:', error);
		
        return new Response(JSON.stringify({ error: 'Si è verificato un errore durante l\'elaborazione dell\'ordine.' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
};
