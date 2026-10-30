// ==UserScript==
// @name         vTDLS Flight Plan Validator
// @namespace    https://artcc.huskey.cc/tools/vtdls-validator/
// @version      1.3.0
// @author       RHG
// @description  KMEM vTDLS flight plan validator using Vector ARTCC KMEM rules
// @match        https://tdls.virtualnas.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      skyvector.com
// @connect      www.skyvector.com
// @run-at       document-idle
// @updateURL    https://github.com/RHGDEV/Artcc-Scripts/raw/main/src/tdls-clearance.user.js
// @downloadURL  https://github.com/RHGDEV/Artcc-Scripts/raw/main/src/tdls-clearance.user.js
// ==/UserScript==

(function () {
	'use strict';

	const PREFIX = '[vTDLS Validator]';
	const VATSIM_API = 'https://data.vatsim.net/v3/vatsim-data.json';
	const VATSIM_AIRPORT_API = 'https://my.vatsim.net/api/v2/aip/airports/';
	let AIRPORT_CODE = '';
	let DEPARTURE_AIRPORT = '';
	let RULES_API = '';
	const PLANE_TYPES_API =
		'https://raw.githubusercontent.com/RHGDEV/Artcc-Scripts/refs/heads/main/data/PlaneTypes.json';
	const AIRLINE_CODES_API =
		'https://raw.githubusercontent.com/npow/airline-codes/refs/heads/master/airlines.json';
	const legacyDepartureFrequencies = GM_getValue('OFFLINE_DEP_FREQ', [
		'122.8',
		'OFFLINE',
	]);
	const legacyGroundFrequencies = GM_getValue('FALLBACK_GROUND_FREQ', []);
	const storedSweatboxFrequencies = GM_getValue('SWEATBOX_FREQUENCIES', null);
	let OFFLINE_DEP_FREQ = Array.isArray(legacyDepartureFrequencies)
		? legacyDepartureFrequencies
		: ['122.8', 'OFFLINE'];
	let SWEATBOX_FREQUENCIES =
		storedSweatboxFrequencies && typeof storedSweatboxFrequencies === 'object'
			? storedSweatboxFrequencies
			: {
					ground: Array.isArray(legacyGroundFrequencies)
						? legacyGroundFrequencies[0] || ''
						: '',
					departure: Array.isArray(legacyDepartureFrequencies)
						? legacyDepartureFrequencies[0] || '122.8'
						: '122.8',
				};
	let FREQUENCY_MODE = GM_getValue('FREQUENCY_MODE', 'Live');

	const airportCache = new Map();
	const airlineCache = new Map();
	let departureFrequencyRequest = null;
	let activeRules = null;
	let activeAircraftTypes = null;
	let rulesRequest = null;
	let planeTypesRequest = null;
	let airlineCodesRequest = null;
	let stationFrequenciesRequest = null;
	let loadNotification = null;
	let scanInProgress = false;
	let scanRequested = false;
	let selectedFlow = '';

	GM_registerMenuCommand('Show Configuration', function () {
		alert(
			[
				`Airport: ${AIRPORT_CODE || 'unknown'} | Mode: ${FREQUENCY_MODE} | Flow: ${selectedFlow || 'none'}`,
				'',
				'Live fallback Frequencies:',
				`  DEP: ${OFFLINE_DEP_FREQ.join(', ') || 'none'}`,
				'',
				'Sweatbox Frequencies:',
				`  GND: ${SWEATBOX_FREQUENCIES.ground || 'none'}`,
				`  DEP: ${SWEATBOX_FREQUENCIES.departure || 'none'}`,
			].join('\n'),
		);
	});

	GM_registerMenuCommand('Set Frequency Mode (Live/Sweatbox)', function () {
		const mode = prompt(
			'Enter frequency mode: Live or Sweatbox',
			FREQUENCY_MODE,
		);

		if (mode === null) return;

		const normalizedMode = mode.trim().toLowerCase();
		if (normalizedMode !== 'live' && normalizedMode !== 'sweatbox') {
			alert('Frequency mode must be Live or Sweatbox.');
			return;
		}

		FREQUENCY_MODE = normalizedMode === 'live' ? 'Live' : 'Sweatbox';
		GM_setValue('FREQUENCY_MODE', FREQUENCY_MODE);
		scheduleScan();
		alert(`Frequency mode set to ${FREQUENCY_MODE}.`);
	});

	GM_registerMenuCommand(
		'Edit Live Fallback Departure Frequencies',
		function () {
			const userInput = prompt(
				'Enter Live fallback Departure frequencies, separated by commas:',
				OFFLINE_DEP_FREQ.join(', '),
			);

			if (userInput === null) return;

			OFFLINE_DEP_FREQ = userInput
				.split(',')
				.map((frequency) => frequency.trim().toUpperCase())
				.filter(Boolean);
			GM_setValue('OFFLINE_DEP_FREQ', OFFLINE_DEP_FREQ);
			scheduleScan();
			alert(
				`Fallback departure frequencies (${OFFLINE_DEP_FREQ.join(', ') || 'none'}) saved successfully!`,
			);
		},
	);

	GM_registerMenuCommand('Edit Sweatbox Frequencies', function () {
		const groundFrequency = prompt(
			'Enter the Sweatbox Ground Frequencies:',
			SWEATBOX_FREQUENCIES.ground || '',
		);

		if (groundFrequency === null) return;

		const departureFrequency = prompt(
			'Enter the Sweatbox Departure Frequencies:',
			SWEATBOX_FREQUENCIES.departure || '',
		);

		if (departureFrequency === null) return;

		SWEATBOX_FREQUENCIES = {
			ground: groundFrequency.trim(),
			departure: departureFrequency.trim(),
		};
		GM_setValue('SWEATBOX_FREQUENCIES', SWEATBOX_FREQUENCIES);
		scheduleScan();
		alert(
			`Sweatbox frequencies saved: GND ${SWEATBOX_FREQUENCIES.ground || 'none'}, DEP ${SWEATBOX_FREQUENCIES.departure || 'none'}`,
		);
	});

	/*
	 * ============================================================
	 * GENERAL HELPERS
	 * ============================================================
	 */

	// Normalize optional text to a single trimmed line.
	function clean(value) {
		return (value || '').replace(/\s+/g, ' ').trim();
	}

	// Normalize text for case-insensitive comparisons.
	function upper(value) {
		return clean(value).toUpperCase();
	}

	function normalizeStationCallsign(callsign) {
		const parts = upper(callsign).split('_');
		return parts.length >= 2 ? `${parts[0]}_${parts.at(-1)}` : upper(callsign);
	}

	// Extract the airline's ICAO prefix from a callsign.
	function getAirlineCode(callsign) {
		const code = upper(callsign).match(/^[A-Z]{3}/)?.[0];

		return code || null;
	}

	// Normalize frequency formatting before comparing values.
	function normalizeFrequency(value) {
		return clean(value)
			.replace(/(\.\d*?[1-9])0+$/, '$1')
			.replace(/\.0+$/, '');
	}

	// Write a namespaced informational message to the console.
	function log(...args) {
		console.log(PREFIX, ...args);
	}

	// Write a namespaced warning message to the console.
	function warn(...args) {
		console.warn(PREFIX, ...args);
	}

	// Check whether text contains a route departing from the active airport.
	function isDepartureRoute(value) {
		return new RegExp(`${DEPARTURE_AIRPORT}\\s*\\.`, 'i').test(clean(value));
	}

	// Read the airport code from the TDLS URL and build the rules endpoint.
	function updateAirportContext() {
		const airportCode =
			location.pathname.match(/^\/([A-Za-z]{3})(?:\/|$)/)?.[1].toUpperCase() ||
			'';

		if (!airportCode) {
			return false;
		}

		AIRPORT_CODE = airportCode;
		DEPARTURE_AIRPORT = `K${airportCode}`;
		RULES_API = `https://raw.githubusercontent.com/RHGDEV/Artcc-Scripts/refs/heads/main/data/${airportCode}.json`;

		return true;
	}

	// Wait until the TDLS URL exposes an airport code.
	function waitForAirportContext() {
		return new Promise((resolve) => {
			const check = () => {
				if (updateAirportContext()) {
					resolve();
					return;
				}

				setTimeout(check, 250);
			};

			check();
		});
	}

	// Fetch and activate the rules for the selected airport.
	async function loadRemoteRules() {
		if (!AIRPORT_CODE) {
			throw new Error('Airport code is missing from the TDLS URL.');
		}

		if (!rulesRequest) {
			rulesRequest = fetch(RULES_API, { cache: 'no-store' })
				.then((response) => {
					if (!response.ok) {
						throw new Error(`Rules request failed (${response.status}).`);
					}

					return response.json();
				})
				.then((remoteRules) => {
					if (!remoteRules || typeof remoteRules !== 'object') {
						throw new Error('Remote rules returned an invalid object.');
					}

					activeRules = remoteRules;
				});
		}

		try {
			await rulesRequest;
		} catch (error) {
			rulesRequest = null;
			throw error;
		}
	}

	// Fetch and activate the shared aircraft classification rules.
	async function loadRemotePlaneTypes() {
		if (!planeTypesRequest) {
			planeTypesRequest = fetch(PLANE_TYPES_API, { cache: 'no-store' })
				.then((response) => {
					if (!response.ok) {
						throw new Error(`Plane types request failed (${response.status}).`);
					}

					return response.json();
				})
				.then((planeTypes) => {
					if (
						!planeTypes ||
						!Array.isArray(planeTypes.jet) ||
						!Array.isArray(planeTypes.prop)
					) {
						throw new Error('Remote plane types returned an invalid object.');
					}

					activeAircraftTypes = planeTypes;
				});
		}

		try {
			await planeTypesRequest;
		} catch (error) {
			planeTypesRequest = null;
			throw error;
		}
	}

	// Fetch and cache airline names and telephony callsigns by ICAO code.
	async function loadAirlineCodes() {
		if (!airlineCodesRequest) {
			airlineCodesRequest = fetch(AIRLINE_CODES_API, { cache: 'force-cache' })
				.then((response) => {
					if (!response.ok) {
						throw new Error(
							`Airline codes request failed (${response.status}).`,
						);
					}

					return response.json();
				})
				.then((data) => {
					const records = Array.isArray(data)
						? data
						: Array.isArray(data?.airlines)
							? data.airlines
							: Object.values(data || {});

					for (const record of records) {
						const code = upper(record?.icao || record?.icao_code);
						const name = clean(
							record?.name || record?.airline || record?.airline_name,
						);
						const callsign = upper(
							record?.callsign || record?.call_sign || record?.telephony,
						);

						if (code && name) {
							airlineCache.set(code, { name, callsign });
						}
					}
				})
				.catch((error) => {
					airlineCodesRequest = null;
					warn('Unable to load airline codes:', error);
				});
		}

		await airlineCodesRequest;
	}

	// Return cached airline information for a callsign.
	function getAirlineInfo(callsign) {
		const code = getAirlineCode(callsign);

		return code ? { code, ...airlineCache.get(code) } : null;
	}

	// Find the highest active departure frequency for the configured center.
	async function getAirportStations() {
		const response = await fetch(`${VATSIM_AIRPORT_API}${DEPARTURE_AIRPORT}`);

		if (!response.ok) {
			throw new Error(`Airport station request failed (${response.status}).`);
		}

		const { data } = await response.json();
		return data?.stations ?? [];
	}

	async function getOnlineStationFrequencies() {
		if (!stationFrequenciesRequest) {
			stationFrequenciesRequest = Promise.all([
				getAirportStations(),
				fetch(VATSIM_API, { cache: 'no-store' }).then((response) => {
					if (!response.ok) {
						throw new Error(`VATSIM data request failed (${response.status}).`);
					}

					return response.json();
				}),
			])
				.then(([stations, vatsim]) => {
					const airportCallsigns = new Set(
						stations
							.map((station) => station.callsign)
							.filter(Boolean)
							.map(normalizeStationCallsign),
					);

					const onlineControllers = vatsim.controllers.filter((controller) =>
						airportCallsigns.has(normalizeStationCallsign(controller.callsign)),
					);

					const groundCallsigns = new Set(
						stations
							.map((station) => station.callsign)
							.filter((callsign) => /_(?:GND|GROUND)$/i.test(callsign || ''))
							.map(normalizeStationCallsign),
					);

					const departureController = [...onlineControllers]
						.filter((controller) => controller.facility > 4)
						.sort((first, second) => second.facility - first.facility)
						.at(0);
					const groundController = onlineControllers.find(
						(controller) =>
							controller.facility === 4 &&
							groundCallsigns.has(
								normalizeStationCallsign(controller.callsign),
							),
					);

					return {
						departureFrequency: departureController?.frequency ?? null,
						groundFrequency: groundController?.frequency ?? null,
					};
				})
				.catch((error) => {
					stationFrequenciesRequest = null;
					throw error;
				});
		}

		return stationFrequenciesRequest;
	}

	async function getOnlineDepartureFrequency() {
		if (!departureFrequencyRequest) {
			departureFrequencyRequest = getOnlineStationFrequencies()
				.then(({ departureFrequency }) => departureFrequency)
				.catch((error) => {
					departureFrequencyRequest = null;
					throw error;
				});
		}

		return departureFrequencyRequest;
	}

	async function getOnlineGroundFrequency() {
		const { groundFrequency } = await getOnlineStationFrequencies();
		return groundFrequency;
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

	function getSkyVectorMatch(html, pattern, description) {
		const match = html.match(pattern);

		if (!match) {
			throw new Error(`Could not find ${description} on the SkyVector page.`);
		}

		return match;
	}

	function requestSkyVectorPage(url) {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: 'GET',
				url,
				timeout: 15000,
				onload: (response) => {
					if (response.status < 200 || response.status >= 300) {
						reject(new Error(`SkyVector request failed (${response.status}).`));
						return;
					}

					resolve(response.responseText);
				},
				onerror: () => reject(new Error('SkyVector request failed.')),
				ontimeout: () => reject(new Error('SkyVector request timed out.')),
			});
		});
	}

	async function getSkyVectorAirport(icao) {
		const html = await requestSkyVectorPage(
			`https://skyvector.com/airport/${icao}`,
		);
		const title = getSkyVectorMatch(
			html,
			/<title>\s*([^<]+?)\s*\|\s*SkyVector\s*<\/title>/i,
			'airport title',
		)[1];
		const coordinates = getSkyVectorMatch(
			html,
			/[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
			'airport coordinates',
		);
		const location = html.match(
			/Located\s+[^<]*?\bof\s+([^,<]+),\s*([^<.]+)[^.]*\./i,
		);

		return {
			icao,
			name: stripTags(title.replace(/^[A-Z0-9]{3}\s*-\s*/, '').trim()),
			city: location?.[1]?.trim() ?? '',
			latitude: Number(coordinates[1]),
			longitude: Number(coordinates[2]),
		};
	}

	// Fetch and cache airport coordinates and display metadata.
	async function getAirportInfo(icao) {
		const code = upper(icao);

		if (!/^[A-Z]{4}$/.test(code)) {
			return null;
		}

		if (!airportCache.has(code)) {
			const request = getSkyVectorAirport(code).then((data) => {
				if (
					!data ||
					typeof data.latitude !== 'number' ||
					typeof data.longitude !== 'number'
				) {
					throw new Error(`Airport ${code} returned incomplete data.`);
				}

				return data;
			});

			airportCache.set(code, request);
		}

		try {
			return await airportCache.get(code);
		} catch (error) {
			airportCache.delete(code);
			throw error;
		}
	}

	// Determine east/west direction from the two airport longitudes.
	function getDirection(departureAirport, destinationAirport) {
		if (!departureAirport || !destinationAirport) {
			return null;
		}

		const departureLongitude = Number(departureAirport.longitude);
		const destinationLongitude = Number(destinationAirport.longitude);

		if (
			!Number.isFinite(departureLongitude) ||
			!Number.isFinite(destinationLongitude)
		) {
			return null;
		}

		const deltaLongitude =
			((destinationLongitude - departureLongitude + 540) % 360) - 180;

		if (deltaLongitude > 0) return 'east';
		if (deltaLongitude < 0) return 'west';
		return null;
	}

	/*
	 * ============================================================
	 * COLOR HANDLING
	 * ============================================================
	 *
	 * We only modify the actual text/select elements.
	 *
	 * Green = valid
	 * Red   = invalid
	 * Yellow = warning / needs verification
	 */

	// Apply validation styling and an optional explanation to an element.
	function mark(element, status, title, expectedOptionText = '') {
		if (!element) return;
		const statusColors = {
			valid: '#22c55e',
			invalid: '#ef4444',
			warning: '#eab308',
		};
		const expectedOptions = Array.isArray(expectedOptionText)
			? expectedOptionText.filter(Boolean)
			: expectedOptionText
				? [expectedOptionText]
				: [];

		if (element.dataset.kmemOriginalColor === undefined) {
			element.dataset.kmemOriginalColor = element.style.color || '';
		}

		if (element.dataset.kmemOriginalWeight === undefined) {
			element.dataset.kmemOriginalWeight = element.style.fontWeight || '';
		}

		if (element.tagName === 'SELECT') {
			for (const option of element.options) {
				if (option.dataset.kmemOriginalColor !== undefined) {
					option.style.color = option.dataset.kmemOriginalColor;
					option.style.fontWeight = option.dataset.kmemOriginalWeight;
					delete option.dataset.kmemOriginalColor;
					delete option.dataset.kmemOriginalWeight;
				}

				option.dataset.kmemOriginalColor = option.style.color || '';
				option.dataset.kmemOriginalWeight = option.style.fontWeight || '';

				if (option.dataset.kmemOriginalComputedColor === undefined) {
					option.dataset.kmemOriginalComputedColor =
						getComputedStyle(option).color;
				}

				option.style.color = option.dataset.kmemOriginalComputedColor;
			}

			const expectedOptionSet = new Set(expectedOptions.map(upper));
			const expectedOptionsFound = [...element.options].filter(
				(option) =>
					expectedOptionSet.has(upper(option.text)) ||
					expectedOptionSet.has(upper(option.value)),
			);

			const selectedOption = element.options[element.selectedIndex];

			if (selectedOption && statusColors[status]) {
				selectedOption.dataset.kmemOriginalColor =
					selectedOption.style.color || '';
				selectedOption.dataset.kmemOriginalWeight =
					selectedOption.style.fontWeight || '';
				selectedOption.style.color = statusColors[status] || '';
				selectedOption.style.fontWeight = '800';
			}

			for (const expectedOption of expectedOptionsFound) {
				if (expectedOption !== selectedOption) {
					expectedOption.style.color = statusColors.valid;
					expectedOption.style.fontWeight = '800';
				}
			}

			if (statusColors[status]) {
				element.style.color = statusColors[status];
			}
		} else if (statusColors[status]) {
			element.style.color = statusColors[status] || '';
			element.style.fontWeight = '800';
		}

		if (title) {
			element.title = title;
		}
	}

	// Restore an element's original inline styles and tooltip.
	function restore(element) {
		if (!element) return;

		if (element.dataset.kmemOriginalColor !== undefined) {
			element.style.color = element.dataset.kmemOriginalColor;
		}

		if (element.dataset.kmemOriginalWeight !== undefined) {
			element.style.fontWeight = element.dataset.kmemOriginalWeight;
		}

		if (element.tagName === 'SELECT') {
			for (const option of element.options) {
				if (option.dataset.kmemOriginalColor !== undefined) {
					option.style.color = option.dataset.kmemOriginalColor;
					option.style.fontWeight = option.dataset.kmemOriginalWeight;
					delete option.dataset.kmemOriginalColor;
					delete option.dataset.kmemOriginalWeight;
				}

				delete option.dataset.kmemOriginalComputedColor;
			}
		}

		delete element.dataset.kmemOriginalColor;
		delete element.dataset.kmemOriginalWeight;

		element.removeAttribute('title');
	}

	// Remove validator-generated UI and restore every field in a card.
	function restoreCard(card) {
		card
			.querySelectorAll('[data-kmem-altitude-hints="true"]')
			.forEach((element) => element.remove());

		card
			.querySelectorAll(
				'[data-kmem-selection-hint="true"], [data-kmem-transition-hint="true"]',
			)
			.forEach((element) => element.remove());

		card.querySelectorAll('[data-kmem-field]').forEach((element) => {
			restore(element);
			delete element.dataset.kmemField;
		});
	}

	// Mark a DOM element as owned by the validator for later cleanup.
	function register(element) {
		if (element) {
			element.dataset.kmemField = 'true';
		}

		return element;
	}

	// Display a styled validator hint after a related form element.
	function showHint(anchor, text, datasetKey) {
		if (!anchor || !text) {
			return;
		}

		const hint = document.createElement('span');
		hint.dataset[datasetKey] = 'true';
		hint.textContent = text;
		hint.style.marginLeft = '6px';
		hint.style.color = '#d86464';
		hint.style.fontWeight = '300';

		anchor.after(hint);
	}

	/*
	 * ============================================================
	 * FIND FLIGHT CARD
	 * ============================================================
	 *
	 * DO NOT depend on styled-components classes.
	 */

	// Find the single visible flight-card container.
	function findFlightCard() {
		const routeElement = [...document.querySelectorAll('div')]
			.reverse()
			.find((div) => isDepartureRoute(div.textContent));

		let current = routeElement;

		for (let depth = 0; depth < 10 && current; depth++) {
			const aircraft = [...current.querySelectorAll('span')].find((span) =>
				/^[A-Z0-9]{2,8}\/[A-Z]$/i.test(clean(span.textContent)),
			);
			const hasControls = current.querySelector('select, input, button');

			if (aircraft && hasControls) {
				return current;
			}

			current = current.parentElement;
		}

		return null;
	}

	/*
	 * ============================================================
	 * CALLSIGN
	 * ============================================================
	 */

	// Read the callsign and its source element from a flight card.
	function getCallsign(card) {
		const routeElement = [...card.querySelectorAll('div')]
			.reverse()
			.find((div) => isDepartureRoute(div.textContent));

		if (!routeElement) {
			return {
				value: '',
				element: null,
			};
		}

		const row = routeElement.parentElement;

		if (!row) {
			return {
				value: '',
				element: null,
			};
		}

		const spans = [...row.querySelectorAll('span')];

		const callsignSpan = spans.find((span) => {
			const value = upper(span.textContent);

			return /^[A-Z]{2,4}\d{1,4}$/.test(value) && !value.includes('/');
		});

		return {
			value: callsignSpan ? upper(callsignSpan.textContent) : '',
			element: callsignSpan || null,
		};
	}

	/*
	 * ============================================================
	 * AIRCRAFT / EQUIPMENT
	 * ============================================================
	 */

	// Read the aircraft type and equipment suffix from a flight card.
	function getAircraft(card) {
		const element = [...card.querySelectorAll('span')].find((span) =>
			/^[A-Z0-9]{2,8}\/[A-Z]$/i.test(clean(span.textContent)),
		);

		if (!element) {
			return {
				value: '',
				type: '',
				equipment: '',
				element: null,
			};
		}

		const value = upper(element.textContent);

		const parts = value.split('/');

		return {
			value,
			type: parts[0],
			equipment: '/' + parts[1],
			element,
		};
	}

	/*
	 * ============================================================
	 * AIRCRAFT CLASSIFICATION
	 * ============================================================
	 *
	 * IMPORTANT:
	 *
	 * A306/L
	 * ^^^^
	 * Aircraft type is A306.
	 *
	 * /L is equipment and MUST NOT determine jet/prop.
	 */

	// Classify an aircraft using the active jet and prop regex lists.
	function getAircraftType(type) {
		const t = upper(type);
		const matches = (patterns) =>
			patterns.some((pattern) => {
				try {
					return new RegExp(pattern).test(t);
				} catch (error) {
					warn(`Invalid aircraft pattern: ${pattern}`, error);
					return false;
				}
			});

		if (matches(activeAircraftTypes?.jet || [])) return 'JET';
		if (matches(activeAircraftTypes?.prop || [])) return 'PROP';

		return 'UNKNOWN';
	}

	/*
	 * ============================================================
	 * EQUIPMENT
	 * ============================================================
	 */

	// Map an equipment suffix to RVSM, RNAV, and GNSS capabilities.
	function getEquipment(equipment) {
		const definitions = {
			'/W': {
				rvsm: true,
				rnav: false,
				gnss: false,
			},

			'/Y': {
				rvsm: false,
				rnav: true,
				gnss: false,
			},

			'/Z': {
				rvsm: true,
				rnav: true,
				gnss: false,
			},

			'/L': {
				rvsm: true,
				rnav: true,
				gnss: true,
			},

			'/G': {
				rvsm: false,
				rnav: true,
				gnss: true,
			},
		};

		return (
			definitions[upper(equipment)] || {
				rvsm: false,
				rnav: false,
				gnss: false,
			}
		);
	}

	/*
	 * ============================================================
	 * ROUTE
	 * ============================================================
	 */

	// Read the route text and its source element from a flight card.
	function getRoute(card) {
		const element = [...card.querySelectorAll('div')]
			.reverse()
			.find((div) => isDepartureRoute(div.textContent));

		return {
			value: element ? clean(element.textContent) : '',
			element: element || null,
		};
	}

	// Extract the destination airport from the final route segment.
	function getDestination(route) {
		const parts = upper(route).split('.').map(clean).filter(Boolean);

		const lastPart = parts[parts.length - 1] || '';
		const destination = lastPart.split('/')[0];

		return /^[A-Z]{4}$/.test(destination) ? destination : '';
	}

	// Build valid hemispheric flight levels for a direction.
	function getValidAltitudes(direction) {
		const lowerLevels = Array.from(
			{ length: 12 },
			(_, index) => 180 + index * 20,
		);

		if (direction === 'west') {
			return [...lowerLevels, 430, 470];
		}

		if (direction === 'east') {
			return lowerLevels.map((level) => level + 10).concat(450, 490);
		}

		return [];
	}

	// Find the closest valid flight levels under an optional ceiling.
	function getNearestValidAltitudes(
		flightLevel,
		direction,
		maximumFlightLevel = null,
	) {
		if (!Number.isFinite(flightLevel) || !direction) {
			return [];
		}

		return getValidAltitudes(direction)
			.filter(
				(level) => maximumFlightLevel === null || level <= maximumFlightLevel,
			)
			.map((level) => ({
				level,
				difference: Math.abs(level - flightLevel),
			}))
			.sort((first, second) => first.difference - second.difference)
			.slice(0, 2)
			.map((item) => item.level);
	}

	/*
	 * ============================================================
	 * SID
	 * ============================================================
	 */

	// Parse the SID and transition from a dot-separated route.
	function parseSID(route) {
		const parts = upper(route).split('.').map(clean).filter(Boolean);

		if (!parts.length) {
			return {
				sid: '',
				transition: '',
			};
		}

		/*
		 * KMEM.BBKNG7.KERMI...
		 *
		 * parts[0] = KMEM
		 * parts[1] = BBKNG7
		 * parts[2] = KERMI
		 */

		return {
			sid: parts[1] || '',
			transition: parts[2] || '',
		};
	}

	/*
	 * ============================================================
	 * SID SELECTS
	 * ============================================================
	 */

	// Locate the SID and transition controls associated with a route.
	function getSIDSelects(card, parsedSID) {
		const selects = [...card.querySelectorAll('select')];

		let sidElement = null;
		let transitionElement = null;

		for (const select of selects) {
			const selectedOption = select.options?.[select.selectedIndex];
			const selectedValues = [
				select.value,
				selectedOption?.value,
				selectedOption?.text,
			].map(upper);
			const optionValues = [...select.options].flatMap((option) => [
				upper(option.value),
				upper(option.text),
			]);

			if (
				parsedSID.sid &&
				(selectedValues.includes(upper(parsedSID.sid)) ||
					optionValues.includes(upper(parsedSID.sid)))
			) {
				sidElement = select;
			}

			if (
				parsedSID.transition &&
				(selectedValues.includes(upper(parsedSID.transition)) ||
					optionValues.includes(upper(parsedSID.transition)))
			) {
				transitionElement = select;
			}
		}

		return {
			sidElement,
			transitionElement,
		};
	}

	// Add and read the flow and runway controls from the DCL card.
	function getRunwayControls(card) {
		let flowPanel = card.querySelector('[data-kmem-flow-controls="true"]');
		const runwaySelect = [...card.querySelectorAll('select')].find((select) =>
			[...select.options].some((option) =>
				/^(RWY ASSIGNED BY GC|EXPECT RWY\s+)/i.test(clean(option.text)),
			),
		);

		if (!flowPanel) {
			flowPanel = document.createElement('div');
			flowPanel.dataset.kmemFlowControls = 'true';
			flowPanel.style.position = 'absolute';
			flowPanel.style.top = '8px';
			flowPanel.style.right = '8px';
			flowPanel.style.zIndex = '2';
			flowPanel.style.display = 'inline-flex';
			flowPanel.style.alignItems = 'center';
			flowPanel.style.gap = '4px';
			flowPanel.style.color = 'inherit';

			const flowLabel = document.createElement('span');
			flowLabel.textContent = '';
			flowLabel.style.color = '#fff';
			flowLabel.style.fontWeight = '700';

			const flowElement = document.createElement('select');
			flowElement.setAttribute('aria-label', 'Current airport flow');
			flowElement.title = 'Select the current airport flow';
			flowElement.style.background = 'transparent';
			flowElement.style.border = 'none';
			flowElement.style.color = '#fff';
			flowElement.style.colorScheme = 'dark';
			flowElement.style.font = 'inherit';
			flowElement.style.padding = '0';

			const emptyOption = document.createElement('option');
			emptyOption.value = '';
			emptyOption.textContent = 'Select flow';
			emptyOption.style.background = '#111827';
			emptyOption.style.color = '#fff';
			flowElement.append(emptyOption);

			const configuredFlows = Object.keys(activeRules?.preferredRunways || {});
			selectedFlow ||= configuredFlows[0] || '';

			for (const flow of configuredFlows) {
				const option = document.createElement('option');
				option.value = flow;
				option.textContent = `${flow} Flow`;
				option.style.background = '#111827';
				option.style.color = '#fff';
				flowElement.append(option);
			}

			flowElement.value = selectedFlow;

			flowPanel.append(flowLabel, flowElement);
			card.prepend(flowPanel);
		}

		const flowElement = flowPanel.querySelector('select');
		let expectedRunwayElement = card.querySelector(
			'[data-kmem-preferred-runway="true"]',
		);

		if (!expectedRunwayElement && runwaySelect) {
			expectedRunwayElement = document.createElement('span');
			expectedRunwayElement.dataset.kmemPreferredRunway = 'true';
			expectedRunwayElement.style.marginLeft = '4px';
			expectedRunwayElement.style.font = 'inherit';
			runwaySelect.after(expectedRunwayElement);
		}

		if (flowElement && !flowElement.dataset.kmemListener) {
			flowElement.dataset.kmemListener = 'true';
			flowElement.addEventListener('change', () => {
				selectedFlow = flowElement.value;
				scheduleScan();
			});
		}

		return {
			flow: clean(flowElement?.value),
			frequencyMode: ['Live', 'Sweatbox'].includes(FREQUENCY_MODE)
				? FREQUENCY_MODE
				: 'Live',
			runway:
				clean(runwaySelect?.options?.[runwaySelect.selectedIndex]?.text).match(
					/^EXPECT RWY\s+(.+)$/i,
				)?.[1] || '',
			flowElement,
			runwayElement: runwaySelect,
			expectedRunwayElement,
		};
	}

	// Resolve the preferred runway for the selected flow and SID base.
	function getPreferredRunway(flow, sid) {
		return clean(activeRules?.preferredRunways?.[flow]?.[getSIDBase(sid)]);
	}

	// Read the selected departure frequency from a flight card.
	function getDepartureFrequency(card) {
		const label = [...card.querySelectorAll('span')].find((span) =>
			upper(span.textContent).startsWith('DEP FREQ'),
		);
		const element = label?.querySelector('select') || null;

		return {
			value: element ? clean(element.value) : '',
			element,
		};
	}

	// Find the ground-frequency clearance instruction select.
	function getGroundInstruction(card) {
		const element = [...card.querySelectorAll('select')].find((select) =>
			[...select.options].some((option) =>
				/^(?:CTC GC|PUSH AT PD CTC GC)\s+/i.test(clean(option.text)),
			),
		);

		return {
			element: element || null,
		};
	}

	/*
	 * ============================================================
	 * FILED ALTITUDE
	 * ============================================================
	 */

	// Read the filed altitude from the card's numeric value pairs.
	function getFiledAltitude(card) {
		/*
		 * vTDLS has two numeric-pair rows:
		 *
		 * FDX358 / 1037
		 * 571   / 330
		 *
		 * The second pair contains filed altitude.
		 */

		const candidates = [];

		for (const div of card.querySelectorAll('div')) {
			const spans = [...div.children].filter(
				(child) => child.tagName === 'SPAN',
			);

			if (spans.length !== 2) {
				continue;
			}

			const first = clean(spans[0].textContent);
			const second = clean(spans[1].textContent);

			if (/^\d+$/.test(first) && /^\d+$/.test(second)) {
				candidates.push({
					first,
					second,
					element: spans[1],
				});
			}
		}

		/*
		 * The last numeric pair is the filed-altitude pair
		 * in the current vTDLS structure.
		 */

		if (!candidates.length) {
			return {
				value: '',
				element: null,
			};
		}

		const candidate = candidates[candidates.length - 1];

		return {
			value: candidate.second,
			element: candidate.element,
		};
	}

	/*
	 * ============================================================
	 * INITIAL ALTITUDE
	 * ============================================================
	 */

	// Read the selected initial-altitude value in feet.
	function getInitialAltitude(card) {
		const select = [...card.querySelectorAll('select')].find((select) => {
			const value = upper(
				select.value || select.options?.[select.selectedIndex]?.text,
			);

			return /^\d{3,5}FT$/.test(value);
		});

		if (!select) {
			return {
				value: '',
				feet: null,
				element: null,
			};
		}

		const value = upper(select.value);

		return {
			value,
			feet: parseInt(value, 10),
			element: select,
		};
	}

	/*
	 * ============================================================
	 * SID CYCLE
	 * ============================================================
	 */

	// Remove the numeric cycle suffix from a SID name.
	function getSIDBase(sid) {
		return upper(sid).replace(/\d+$/, '');
	}

	// Look up the configured cycle for a SID base.
	function getSIDCycle(sid) {
		const base = getSIDBase(sid);

		return activeRules.sidCycles[base] ?? null;
	}

	// Return a SID with its configured current cycle.
	function getCurrentSID(sid) {
		const base = getSIDBase(sid);
		const cycle = getSIDCycle(sid);

		return cycle === null ? sid : `${base}${cycle}`;
	}

	// Check whether a SID uses its configured current cycle.
	function isCurrentSID(sid) {
		const base = getSIDBase(sid);
		const cycle = getSIDCycle(sid);

		if (cycle === null) {
			return true;
		}

		return new RegExp(`${base}${cycle}$`, 'i').test(upper(sid));
	}

	/*
	 * ============================================================
	 * DEPARTURE RULE
	 * ============================================================
	 *
	 * Uses the KMEM rules:
	 *
	 * Restricted departures:
	 *
	 * AUTMN -> CHLDR / ANSWA
	 * BINKY -> PIEPE / IBUFY
	 * GENEH -> CRSON / HUMMS
	 * GMBUD -> BBKING / KERMI
	 * GRRIZ -> JTEEE / ODATE
	 * HOTRD -> ZUMIT / JTEEE
	 * NIKEI -> ZUMIT / FOXOM
	 * OLEMS -> PIEPE / IBUFY
	 *
	 * Non-RNAV aircraft:
	 *
	 * departure -> ELVIS4
	 * ============================================================
	 */

	// Resolve restricted and non-RNAV departure requirements.
	function getDepartureRule(sid, transition, equipment, aircraftCategory) {
		const sidBase = getSIDBase(sid);

		const restriction = activeRules.restrictedDepartures[sidBase];

		if (aircraftCategory === 'PROP' || !equipment.rnav) {
			/* Resolve restricted departures before finding the ELVIS gate. */
			const departureBase = getSIDBase(restriction?.[0] || sidBase);
			const expectedTransition =
				activeRules.rvsmOnly.transitions[departureBase] || null;
			const expectedDeparture =
				activeRules.rvsmOnly.departure +
				getSIDCycle(activeRules.rvsmOnly.departure);

			return {
				type: 'RNAV',
				validDeparture: upper(sid) === upper(expectedDeparture),
				expectedDeparture,
				expectedTransition,
				validTransition: expectedTransition
					? upper(transition) === upper(expectedTransition)
					: true,
			};
		}

		/*
		 * Normal restricted departure mapping.
		 */

		if (!restriction) {
			return {
				type: 'NORMAL',
				validDeparture: true,
				validTransition: true,
				expectedDeparture: null,
				expectedTransition: null,
			};
		}
		const expectedSID = restriction[0];

		const expectedTransition = restriction[1];

		return {
			type: 'RESTRICTED',
			validDeparture: upper(sid) === upper(expectedSID),
			validTransition: upper(transition) === upper(expectedTransition),
			expectedDeparture: expectedSID,
			expectedTransition,
		};
	}

	/*
	 * ============================================================
	 * ALTITUDE DIRECTION
	 * ============================================================
	 *
	 * The vTDLS DOM work is kept separate from the actual validator
	 * logic so that the displayed FL is always read correctly.
	 *
	 * The script will calculate directional altitude when the route
	 * gives us enough information.
	 *
	 * If it cannot confidently calculate it, it will show yellow
	 * rather than falsely declaring an altitude valid/invalid.
	 */

	// Parse a flight-level value into a number.
	function parseFlightLevel(value) {
		const number = parseInt(value, 10);

		if (!Number.isFinite(number)) {
			return null;
		}

		return number;
	}

	/*
	 * ============================================================
	 * VALIDATE CARD
	 * ============================================================
	 */

	// Validate one flight card and apply field-level feedback.
	async function validateCard(card) {
		restoreCard(card);

		const callsign = getCallsign(card);
		const airline = getAirlineInfo(callsign.value);

		if (callsign.element) {
			if (airline?.name) {
				const telephony = airline.callsign ? ` (${airline.callsign})` : '';
				callsign.element.title = `${airline.code} - ${airline.name}${telephony}`;
			} else {
				callsign.element.removeAttribute('title');
			}
		}

		const aircraft = getAircraft(card);
		const route = getRoute(card);

		const destination = getDestination(route.value);

		const [departureAirport, destinationAirport] = await Promise.all([
			getAirportInfo(DEPARTURE_AIRPORT),
			getAirportInfo(destination),
		]).catch((error) => {
			warn('Airport lookup failed:', error);
			return [null, null];
		});

		const altitudeDirection = getDirection(
			departureAirport,
			destinationAirport,
		);

		if (route.element) {
			if (destinationAirport?.name) {
				route.element.title = destinationAirport.name;
			} else {
				route.element.removeAttribute('title');
			}
		}

		const parsedSID = parseSID(route.value);

		const sidElements = getSIDSelects(card, parsedSID);
		const runwayControls = getRunwayControls(card);

		const filedAltitude = getFiledAltitude(card);

		const initialAltitude = getInitialAltitude(card);

		const departureFrequency = getDepartureFrequency(card);
		const groundInstruction = getGroundInstruction(card);

		const equipment = getEquipment(aircraft.equipment);

		const aircraftCategory = getAircraftType(aircraft.type);

		let onlineDepartureFrequency = null;
		let onlineGroundFrequency = null;
		const useSweatbox = runwayControls.frequencyMode === 'Sweatbox';

		if (!useSweatbox) {
			try {
				const stationFrequencies = await getOnlineStationFrequencies();
				onlineDepartureFrequency = stationFrequencies.departureFrequency;
				onlineGroundFrequency = stationFrequencies.groundFrequency;
			} catch (error) {
				warn('Unable to determine online station frequencies:', error);
			}
		}

		/*
		 * --------------------------------------------------------
		 * Initial altitude
		 * --------------------------------------------------------
		 */

		const expectedInitialAltitude =
			aircraftCategory === 'JET'
				? activeRules.initialAltitudes.jets
				: aircraftCategory === 'PROP'
					? activeRules.initialAltitudes.props
					: null;

		const initialAltitudeValid =
			expectedInitialAltitude !== null &&
			initialAltitude.feet === expectedInitialAltitude;

		const normalizedDepartureFrequency = normalizeFrequency(
			departureFrequency.value,
		);

		const departureExpectedFrequencies = useSweatbox
			? SWEATBOX_FREQUENCIES.departure
				? [SWEATBOX_FREQUENCIES.departure]
				: []
			: onlineDepartureFrequency !== null
				? [onlineDepartureFrequency]
				: OFFLINE_DEP_FREQ;
		const departureFrequencyValid = departureExpectedFrequencies.some(
			(expectedFrequency) =>
				upper(normalizedDepartureFrequency) ===
				upper(normalizeFrequency(expectedFrequency)),
		);

		/*
		 * --------------------------------------------------------
		 * SID cycle
		 * --------------------------------------------------------
		 */

		const sidCurrent = isCurrentSID(parsedSID.sid);
		const preferredRunway = getPreferredRunway(
			runwayControls.flow,
			parsedSID.sid,
		);
		const runwayValid =
			Boolean(runwayControls.flow && preferredRunway) &&
			runwayControls.runway === upper(preferredRunway);

		if (runwayControls.expectedRunwayElement) {
			runwayControls.expectedRunwayElement.textContent = preferredRunway
				? `RWY ${preferredRunway}`
				: '';
		}

		/*
		 * --------------------------------------------------------
		 * Departure rule
		 * --------------------------------------------------------
		 */

		const departureRule = getDepartureRule(
			parsedSID.sid,
			parsedSID.transition,
			equipment,
			aircraftCategory,
		);
		if (
			!sidCurrent ||
			(departureRule.expectedDeparture && !departureRule.validDeparture) ||
			(departureRule.expectedTransition && !departureRule.validTransition)
		) {
			showHint(
				sidElements.sidElement || sidElements.transitionElement,
				`${getCurrentSID(departureRule.expectedDeparture) || 'UNKNOWN'} ${departureRule.expectedTransition || 'UNKNOWN'}`,
				'kmemSelectionHint',
			);
		} else {
			showHint(
				sidElements.sidElement || sidElements.transitionElement,
				'',
				'kmemSelectionHint',
			);
		}
		const filedFlightLevel = parseFlightLevel(filedAltitude.value);

		const nonRvsmCeilingExceeded =
			!equipment.rvsm && filedFlightLevel !== null && filedFlightLevel >= 290;

		const filedAltitudeValid =
			!nonRvsmCeilingExceeded &&
			altitudeDirection &&
			getValidAltitudes(altitudeDirection).includes(filedFlightLevel);

		const nearestValidAltitudes = getNearestValidAltitudes(
			filedFlightLevel,
			altitudeDirection,
			equipment.rvsm ? null : 290,
		);

		/*
		 * --------------------------------------------------------
		 * Apply colors
		 * --------------------------------------------------------
		 */

		register(aircraft.element);

		register(sidElements.sidElement);
		register(sidElements.transitionElement);
		register(runwayControls.flowElement);
		register(runwayControls.runwayElement);
		register(runwayControls.expectedRunwayElement);

		register(filedAltitude.element);
		register(initialAltitude.element);
		register(departureFrequency.element);
		register(groundInstruction.element);

		/*
		 * Aircraft
		 */

		if (aircraft.element) {
			mark(
				aircraft.element,
				aircraftCategory === 'UNKNOWN' ? 'warning' : 'valid',
				aircraftCategory === 'UNKNOWN'
					? `${aircraft.type} could not be classified as jet or prop. Verify the aircraft type.`
					: `${aircraft.type} classified as ${aircraftCategory}. Equipment ${aircraft.equipment}.`,
			);
		}

		/*
		 * Initial altitude
		 */

		if (initialAltitude.element) {
			mark(
				initialAltitude.element,
				expectedInitialAltitude === null
					? 'warning'
					: initialAltitudeValid
						? 'valid'
						: 'invalid',

				expectedInitialAltitude === null
					? `${aircraft.type} type is unclassified. Verify the required initial altitude.`
					: initialAltitudeValid
						? `${aircraft.type} is a ${aircraftCategory.toLowerCase()}. ${expectedInitialAltitude}FT is correct.`
						: `${aircraft.type} is a ${aircraftCategory.toLowerCase()}. Expected ${expectedInitialAltitude}FT.`,
				expectedInitialAltitude === null ? '' : `${expectedInitialAltitude}FT`,
			);
		}

		if (departureFrequency.element) {
			mark(
				departureFrequency.element,
				departureFrequencyValid ? 'valid' : 'invalid',
				useSweatbox
					? departureFrequencyValid
						? `Sweatbox DEP frequency ${SWEATBOX_FREQUENCIES.departure} is correct.`
						: `Expected Sweatbox DEP frequency ${SWEATBOX_FREQUENCIES.departure || 'not configured'}.`
					: onlineDepartureFrequency === null
						? departureFrequencyValid
							? `No higher facility is online. ${departureFrequency.value} is valid.`
							: `No higher facility is online. Use ${OFFLINE_DEP_FREQ.join(', ')}`
						: departureFrequencyValid
							? `Departure frequency ${onlineDepartureFrequency} is correct.`
							: `Expected departure frequency ${onlineDepartureFrequency}.`,
				departureExpectedFrequencies,
			);
		}

		const groundFrequencies = useSweatbox
			? SWEATBOX_FREQUENCIES.ground
				? [SWEATBOX_FREQUENCIES.ground]
				: []
			: onlineGroundFrequency
				? [onlineGroundFrequency]
				: [];

		if (groundInstruction.element && groundFrequencies.length) {
			const expectedGroundOptions = groundFrequencies.flatMap((frequency) => {
				const normalizedFrequency = normalizeFrequency(frequency);

				return [
					`CTC GC ${frequency}`,
					`PUSH AT PD CTC GC ${frequency}`,
					`CTC GC ${normalizedFrequency}`,
					`PUSH AT PD CTC GC ${normalizedFrequency}`,
				];
			});
			const fallbackGround = useSweatbox;

			mark(
				groundInstruction.element,
				null,
				fallbackGround
					? `${useSweatbox ? 'Sweatbox' : 'Fallback'} ground frequencies: ${groundFrequencies.join(', ')}.`
					: `Ground frequency ${onlineGroundFrequency} is online.`,
				expectedGroundOptions,
			);
		}

		/*
		 * SID
		 */

		const sidElement = sidElements.sidElement;

		if (sidElement) {
			mark(
				sidElement,
				sidCurrent ? 'valid' : 'invalid',

				sidCurrent
					? `SID ${parsedSID.sid} is current and valid.`
					: `SID ${parsedSID.sid} is not current. Expected ${getSIDBase(parsedSID.sid)}${getSIDCycle(parsedSID.sid)}.`,
				getCurrentSID(parsedSID.sid),
			);
		}

		/*
		 * Restricted/RVSM departure.
		 *
		 * Only apply these checks when the rule actually has an
		 * applicable restriction.
		 */

		if (departureRule.expectedDeparture && sidElements.sidElement) {
			const departureValid = departureRule.validDeparture;

			mark(
				sidElements.sidElement,
				departureValid ? 'valid' : 'invalid',

				departureValid
					? `Departure ${parsedSID.sid} is correct.`
					: `Expected departure ${departureRule.expectedDeparture}.`,
				departureRule.expectedDeparture,
			);
		}

		/*
		 * Transition.
		 */

		if (sidElements.transitionElement && departureRule.expectedTransition) {
			mark(
				sidElements.transitionElement,

				departureRule.validTransition ? 'valid' : 'invalid',

				departureRule.validTransition
					? `Transition ${parsedSID.transition} is correct.`
					: `Expected transition ${departureRule.expectedTransition}.`,
				departureRule.expectedTransition,
			);
		}

		/* Preferred runway. */

		if (runwayControls.runwayElement) {
			mark(
				runwayControls.runwayElement,
				runwayControls.flow && preferredRunway
					? runwayValid
						? 'valid'
						: 'invalid'
					: 'warning',
				preferredRunway
					? runwayValid
						? `Runway ${runwayControls.runway} matches the ${runwayControls.flow} flow.`
						: `Expected runway ${preferredRunway} for the ${runwayControls.flow} flow.`
					: runwayControls.flow
						? `No preferred runway is configured for SID ${parsedSID.sid}.`
						: 'Select a flow before verifying the assigned runway.',
				preferredRunway ? `EXPECT RWY ${preferredRunway}` : '',
			);
		}

		if (runwayControls.expectedRunwayElement && preferredRunway) {
			mark(
				runwayControls.expectedRunwayElement,
				runwayValid ? 'valid' : 'warning',
				runwayValid
					? `Assigned runway matches the preferred runway ${preferredRunway}.`
					: `Preferred runway for the ${runwayControls.flow} flow is ${preferredRunway}.`,
			);
		}

		/* Filed altitude. */

		if (filedAltitude.element) {
			showHint(
				filedAltitude.element,
				nonRvsmCeilingExceeded
					? 'FL280 MAX'
					: filedAltitudeValid === false && nearestValidAltitudes.length === 2
						? `${nearestValidAltitudes[0]}/${nearestValidAltitudes[1]}`
						: '',
				'kmemAltitudeHints',
			);

			const altitudeTitle = nonRvsmCeilingExceeded
				? `Filed altitude FL${filedAltitude.value} is invalid. Non-RVSM aircraft must remain below FL290.`
				: altitudeDirection
					? filedAltitudeValid
						? `Altitude ${filedAltitude.value} is valid for ${altitudeDirection}bound traffic.`
						: `Altitude ${filedAltitude.value} is invalid for ${altitudeDirection}bound traffic. Closest valid altitudes: ${nearestValidAltitudes[0]}/${nearestValidAltitudes[1]}.`
					: `Altitude FL${filedAltitude.value}. Direction for destination ${destination || 'unknown'} could not be determined.`;

			mark(
				filedAltitude.element,
				nonRvsmCeilingExceeded
					? 'invalid'
					: altitudeDirection
						? filedAltitudeValid
							? 'valid'
							: 'invalid'
						: 'warning',
				altitudeTitle,
			);
		}

		/*
		 * --------------------------------------------------------
		 * Console diagnostics
		 * --------------------------------------------------------
		 */

		console.group(`${PREFIX} ${callsign.value || 'UNKNOWN'}`);

		console.log('Callsign:', callsign.value);

		console.log('Aircraft:', aircraft.value);

		console.log('Aircraft Type:', aircraft.type);

		console.log('Equipment:', aircraft.equipment);

		console.log('Aircraft Category:', aircraftCategory);

		console.log('RVSM:', equipment.rvsm);

		console.log('RNAV:', equipment.rnav);

		console.log('GNSS:', equipment.gnss);

		console.log('Route:', route.value);

		console.log('SID:', parsedSID.sid);

		console.log('Transition:', parsedSID.transition);

		console.log('SID Current:', sidCurrent);

		console.log(
			'Filed Altitude:',
			filedAltitude.value ? `FL${filedAltitude.value}` : 'NOT FOUND',
		);

		console.log('Initial Altitude:', initialAltitude.value);

		console.log('Expected Initial:', `${expectedInitialAltitude}FT`);

		console.log('Initial Altitude Valid:', initialAltitudeValid);

		console.log('Departure Rule:', departureRule);

		console.groupEnd();
	}

	/*
	 * ============================================================
	 * SCAN
	 * ============================================================
	 */

	let scanTimer = null;

	async function scan() {
		if (!activeRules || !activeAircraftTypes) {
			return;
		}

		if (scanInProgress) {
			scanRequested = true;
			return;
		}

		scanInProgress = true;

		try {
			const card = findFlightCard();
			if (card === null) {
				console.log(`No flight card found.`);
				return;
			}
			log(`Found a flight card.`);

			try {
				await validateCard(card);
			} catch (error) {
				console.error(PREFIX, 'Failed to validate flight card:', error);
			}
		} finally {
			scanInProgress = false;

			if (scanRequested) {
				scanRequested = false;
				scheduleScan();
			}
		}
	}

	function scheduleScan() {
		clearTimeout(scanTimer);

		scanTimer = setTimeout(scan, 1550);
	}

	function showLoadNotification(message, success, duration = 3000) {
		loadNotification?.remove();

		const notification = document.createElement('div');
		loadNotification = notification;

		notification.textContent = message;
		notification.style.position = 'fixed';
		notification.style.top = '16px';
		notification.style.right = '16px';
		notification.style.zIndex = '2147483647';
		notification.style.padding = '8px 12px';
		notification.style.border = `1px solid ${success ? '#22c55e' : '#ef4444'}`;
		notification.style.borderRadius = '4px';
		notification.style.background = success ? '#14532d' : '#7f1d1d';
		notification.style.color = success ? '#dcfce7' : '#fee2e2';
		notification.style.font = '600 13px sans-serif';
		notification.style.opacity = '1';
		notification.style.transition = 'opacity 300ms ease';

		document.body.append(notification);

		if (duration > 0) {
			setTimeout(() => {
				notification.style.opacity = '0';
				setTimeout(() => notification.remove(), 300);
			}, duration);
		}
	}

	/*
	 * ============================================================
	 * OBSERVE vTDLS
	 * ============================================================
	 */

	const observer = new MutationObserver(() => {
		scheduleScan();
	});

	observer.observe(document.body, {
		childList: true,
		subtree: true,
		characterData: true,
	});

	/*
	 * ============================================================
	 * START
	 * ============================================================
	 */

	log('KMEM vTDLS validator waiting for airport selection.');
	showLoadNotification('Waiting for airport selection...', true, 0);

	waitForAirportContext()
		.then(() =>
			Promise.all([
				loadRemoteRules(),
				loadRemotePlaneTypes(),
				loadAirlineCodes(),
			]),
		)
		.then(async () => {
			log(`${DEPARTURE_AIRPORT} validator data loaded.`);
			await scan();
			showLoadNotification(
				`${DEPARTURE_AIRPORT} validator loaded successfully`,
				true,
			);
		})
		.catch((error) => {
			console.error(PREFIX, 'Unable to load validator data:', error);
			showLoadNotification(
				`${DEPARTURE_AIRPORT || 'Airport'} validator failed to load: ${error.message}`,
				false,
			);
		});
})();
