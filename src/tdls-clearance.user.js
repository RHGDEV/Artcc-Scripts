// ==UserScript==
// @name         vTDLS Flight Plan Validator
// @namespace    https://artcc.huskey.cc/tools/vtdls-validator/
// @version      1.0.1
// @description  KMEM vTDLS flight plan validator using Vector ARTCC KMEM rules
// @match        https://tdls.virtualnas.net/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/RHGDEV/Artcc-Scripts/raw/main/src/tdls-clearance.user.js
// @downloadURL  https://github.com/RHGDEV/Artcc-Scripts/raw/main/src/tdls-clearance.user.js
// ==/UserScript==

(function () {
	'use strict';

	const PREFIX = '[vTDLS Validator]';
	const VATSIM_API = 'https://data.vatsim.net/v3/vatsim-data.json';
	const AIRPORT_API = 'https://ryanburnette.github.io/airports-api/icao/';
	const VATSIM_AIRPORT_API = 'https://my.vatsim.net/api/v2/aip/airports/';
	let AIRPORT_CODE = '';
	let DEPARTURE_AIRPORT = '';
	let RULES_API = '';
	const PLANE_TYPES_API =
		'https://raw.githubusercontent.com/RHGDEV/Artcc-Scripts/refs/heads/main/rules/PlaneTypes.json';
	const AIRLINE_CODES_API =
		'https://raw.githubusercontent.com/npow/airline-codes/refs/heads/master/airlines.json';
	const FALLBACK_DEPARTURE_FREQUENCIES = ['122.8', 'OFFLINE'];

	const airportCache = new Map();
	const airlineCache = new Map();
	let departureFrequencyRequest = null;
	let activeRules = null;
	let activeAircraftTypes = null;
	let rulesRequest = null;
	let planeTypesRequest = null;
	let airlineCodesRequest = null;
	let loadNotification = null;
	let scanInProgress = false;
	let scanRequested = false;

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
		RULES_API = `https://raw.githubusercontent.com/RHGDEV/Artcc-Scripts/refs/heads/main/rules/${airportCode}.json`;

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

	async function getOnlineDepartureFrequency() {
		if (!departureFrequencyRequest) {
			departureFrequencyRequest = Promise.all([
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

					const onlineControllers = vatsim.controllers
						.filter(
							(controller) =>
								controller.facility > 4 &&
								airportCallsigns.has(
									normalizeStationCallsign(controller.callsign),
								),
						)
						.sort((first, second) => second.facility - first.facility);

					return onlineControllers.at(0)?.frequency ?? null;
				})
				.catch((error) => {
					departureFrequencyRequest = null;
					throw error;
				});
		}

		return departureFrequencyRequest;
	}

	// Fetch and cache airport coordinates and display metadata.
	async function getAirportInfo(icao) {
		const code = upper(icao);

		if (!/^[A-Z]{4}$/.test(code)) {
			return null;
		}

		if (!airportCache.has(code)) {
			const request = fetch(`${AIRPORT_API}${code.toLowerCase()}.json`, {
				cache: 'force-cache',
			})
				.then((response) => {
					if (!response.ok) {
						throw new Error(`Airport ${code} could not be found.`);
					}

					return response.json();
				})
				.then((data) => {
					if (
						!data ||
						typeof data.latitude !== 'number' ||
						typeof data.longitude !== 'number'
					) {
						throw new Error(`Airport ${code} returned incomplete data.`);
					}

					return {
						icao: upper(data.icao || code),
						name: data.airport_name || data.name || code,
						city: data.city || '',
						latitude: Number(data.latitude),
						longitude: Number(data.longitude),
					};
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
	function mark(element, status, title) {
		if (!element) return;

		if (!element.dataset.kmemOriginalColor) {
			element.dataset.kmemOriginalColor = element.style.color || '';
		}

		if (!element.dataset.kmemOriginalWeight) {
			element.dataset.kmemOriginalWeight = element.style.fontWeight || '';
		}

		if (status === 'valid') {
			element.style.color = '#22c55e';
		}

		if (status === 'invalid') {
			element.style.color = '#ef4444';
		}

		if (status === 'warning') {
			element.style.color = '#eab308';
		}

		element.style.fontWeight = '800';

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
	function getDepartureRule(sid, transition, equipment) {
		const sidBase = getSIDBase(sid);

		const restriction = activeRules.restrictedDepartures[sidBase];

		if (!equipment.rnav) {
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

		const filedAltitude = getFiledAltitude(card);

		const initialAltitude = getInitialAltitude(card);

		const departureFrequency = getDepartureFrequency(card);

		const equipment = getEquipment(aircraft.equipment);

		const aircraftCategory = getAircraftType(aircraft.type);

		let onlineDepartureFrequency = null;

		try {
			onlineDepartureFrequency = await getOnlineDepartureFrequency();
		} catch (error) {
			warn('Unable to determine the online departure frequency:', error);
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

		const departureFrequencyValid =
			onlineDepartureFrequency !== null
				? normalizedDepartureFrequency ===
					normalizeFrequency(onlineDepartureFrequency)
				: FALLBACK_DEPARTURE_FREQUENCIES.includes(
						upper(normalizedDepartureFrequency),
					);

		/*
		 * --------------------------------------------------------
		 * SID cycle
		 * --------------------------------------------------------
		 */

		const sidCurrent = isCurrentSID(parsedSID.sid);

		/*
		 * --------------------------------------------------------
		 * Departure rule
		 * --------------------------------------------------------
		 */

		const departureRule = getDepartureRule(
			parsedSID.sid,
			parsedSID.transition,
			equipment,
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

		register(filedAltitude.element);
		register(initialAltitude.element);
		register(departureFrequency.element);

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
			);
		}

		if (departureFrequency.element) {
			mark(
				departureFrequency.element,
				departureFrequencyValid ? 'valid' : 'invalid',
				onlineDepartureFrequency === null
					? departureFrequencyValid
						? 'No higher facility is online. 122.8 or OFFLINE is valid.'
						: 'No higher facility is online. Use 122.8 or OFFLINE.'
					: departureFrequencyValid
						? `Departure frequency ${onlineDepartureFrequency} is correct.`
						: `Expected departure frequency ${onlineDepartureFrequency}.`,
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
