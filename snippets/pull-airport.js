const airportCode = process.argv[2]?.trim().toUpperCase();

if (!airportCode || !/^[A-Z]{4}$/.test(airportCode)) {
	console.error('Usage: node scripts/pull-airport.js <ICAO>');
	process.exitCode = 1;
} else {
	getAirport(airportCode)
		.then((airport) => console.log(JSON.stringify(airport, null, 4)))
		.catch((error) => {
			console.error(error.message);
			process.exitCode = 1;
		});
}

function decodeHtml(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
			String.fromCodePoint(Number.parseInt(code, 16)),
		)
		.replace(/&#(\d+);/g, (_, code) =>
			String.fromCodePoint(Number.parseInt(code, 10)),
		)
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function stripTags(value) {
	return decodeHtml(value.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

function getMatch(html, pattern, description) {
	const match = html.match(pattern);

	if (!match) {
		throw new Error(`Could not find ${description} on the SkyVector page.`);
	}

	return match;
}

async function getAirport(icao) {
	const response = await fetch(`https://skyvector.com/airport/${icao}`, {
		headers: {
			'User-Agent': 'ARTCC airport data importer',
		},
	});

	if (!response.ok) {
		throw new Error(`SkyVector request failed (${response.status}).`);
	}

	const html = await response.text();
	const title = getMatch(
		html,
		/<title>\s*([^<]+?)\s*\|\s*SkyVector\s*<\/title>/i,
		'airport title',
	)[1];
	const name = title.replace(/^[A-Z0-9]{3}\s*-\s*/, '').trim();
	const iata = getMatch(
		html,
		/href="\/airport\/([A-Z0-9]{3})(?:\/|"|\?)/i,
		'IATA code',
	)[1].toUpperCase();
	const coordinates = getMatch(
		html,
		/[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
		'airport coordinates',
	);
	const location = html.match(
		/Located\s+[^<]*?\bof\s+([^,<]+),\s*([^<.]+)[^.]*\./i,
	);
	const elevation = html.match(/Surveyed Elevation is\s*(\d+)\s+feet/i);

	return {
		_csv_row: null,
		airport_name: stripTags(name),
		city: location?.[1]?.trim() ?? '',
		country: 'United States',
		iata,
		icao,
		latitude: Number(coordinates[1]),
		longitude: Number(coordinates[2]),
		elevation: elevation ? Number(elevation[1]) : null,
		utc_offset: null,
		_class: null,
		timezone: null,
	};
}
