// ==UserScript==
// @name         vTDLS Flight Plan Validator
// @namespace    https://artcc.huskey.cc/tools/vtdls-validator/
// @version      0.5.0
// @description  KMEM vTDLS flight plan validator using Vector ARTCC KMEM rules
// @match        https://tdls.virtualnas.net/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/RHGDEV/Artcc-Scripts/raw/main/src/kmem-clearance.user.js
// @downloadURL  https://github.com/RHGDEV/Artcc-Scripts/raw/main/src/kmem-clearance.user.js
// ==/UserScript==

(function () {
	'use strict';

	const PREFIX = '[vTDLS Validator]';
	const VATSIM_API = 'https://data.vatsim.net/v3/vatsim-data.json';
	const AIRPORT_API = 'https://ryanburnette.github.io/airports-api/icao/';
	let AIRPORT_CODE = '';
	let DEPARTURE_AIRPORT = '';
	let RULES_API = '';
	const PLANE_TYPES_API =
		'https://raw.githubusercontent.com/RHGDEV/Artcc-Scripts/refs/heads/main/rules/PlaneTypes.json';
	const FALLBACK_DEPARTURE_FREQUENCIES = ['122.8', 'OFFLINE'];

	const airportCache = new Map();
	let departureFrequencyRequest = null;
	let activeRules = null;
	let activeAircraftTypes = null;
	let rulesRequest = null;
	let planeTypesRequest = null;
	let loadNotification = null;
	let scanInProgress = false;
	let scanRequested = false;

	/*
	 * ============================================================
	 * GENERAL HELPERS
	 * ============================================================
	 */

	function clean(value) {
		return (value || '').replace(/\s+/g, ' ').trim();
	}

	function upper(value) {
		return clean(value).toUpperCase();
	}

	function normalizeFrequency(value) {
		return clean(value)
			.replace(/(\.\d*?[1-9])0+$/, '$1')
			.replace(/\.0+$/, '');
	}

	function log(...args) {
		console.log(PREFIX, ...args);
	}

	function warn(...args) {
		console.warn(PREFIX, ...args);
	}

	function isDepartureRoute(value) {
		return new RegExp(`${DEPARTURE_AIRPORT}\\s*\\.`, 'i').test(clean(value));
	}

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

	async function getOnlineDepartureFrequency() {
		if (!departureFrequencyRequest) {
			departureFrequencyRequest = fetch(VATSIM_API, { cache: 'no-store' })
				.then((response) => {
					if (!response.ok) {
						throw new Error(`VATSIM data request failed (${response.status}).`);
					}

					return response.json();
				})
				.then((vatsim) => {
					const controller = vatsim.controllers
						.filter((item) => {
							const callsign = upper(item.callsign);
							const facility = Number(item.facility);
							const centerCode = upper(activeRules?.centerCode);

							return callsign.startsWith(`${centerCode}_`) && facility >= 5;
						})
						.sort(
							(a, b) =>
								Number(a.facility) - Number(b.facility) ||
								upper(a.callsign).localeCompare(upper(b.callsign)),
						)
						.at(0);

					return controller?.frequency || null;
				})
				.catch((error) => {
					departureFrequencyRequest = null;
					throw error;
				});
		}

		return departureFrequencyRequest;
	}

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

		element.style.fontWeight = '700';

		if (title) {
			element.title = title;
		}
	}

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

	function restoreCard(card) {
		card
			.querySelectorAll('[data-kmem-altitude-hints="true"]')
			.forEach((element) => element.remove());

		card
			.querySelectorAll('[data-kmem-selection-hint="true"]')
			.forEach((element) => element.remove());

		card.querySelectorAll('[data-kmem-field]').forEach((element) => {
			restore(element);
			delete element.dataset.kmemField;
		});
	}

	function register(element) {
		if (element) {
			element.dataset.kmemField = 'true';
		}

		return element;
	}

	function showSelectionHint(
		departureElement,
		transitionElement,
		correctDeparture,
		correctTransition,
	) {
		const values = [];

		if (correctDeparture && correctTransition) {
			values.push(`${correctDeparture} ${correctTransition}`);
		}

		if (!values.length) {
			return;
		}

		const hint = document.createElement('span');
		hint.dataset.kmemSelectionHint = 'true';
		hint.textContent = values.join(' | ');
		hint.style.marginLeft = '6px';
		hint.style.color = '#ef4444';
		hint.style.fontWeight = '700';

		const anchor = transitionElement || departureElement;
		anchor?.after(hint);
	}

	/*
	 * ============================================================
	 * FIND FLIGHT CARD
	 * ============================================================
	 *
	 * DO NOT depend on styled-components classes.
	 */

	function findFlightCards() {
		const cards = new Set();

		for (const div of document.querySelectorAll('div')) {
			const text = clean(div.textContent);

			if (!isDepartureRoute(text)) {
				continue;
			}

			let current = div;

			for (let i = 0; i < 10 && current; i++) {
				const currentText = clean(current.textContent);

				const aircraft = [...current.querySelectorAll('span')].find((span) =>
					/^[A-Z0-9]{2,8}\/[A-Z]$/i.test(clean(span.textContent)),
				);

				const controls = current.querySelectorAll(
					'select, input, button',
				).length;

				if (aircraft && controls > 0 && isDepartureRoute(currentText)) {
					cards.add(current);
					break;
				}

				current = current.parentElement;
			}
		}

		return [...cards];
	}

	/*
	 * ============================================================
	 * CALLSIGN
	 * ============================================================
	 */

	function getCallsign(card) {
		const routeElement = [...card.querySelectorAll('div')].find((div) =>
			isDepartureRoute(div.textContent),
		);

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

	function getRoute(card) {
		const element = [...card.querySelectorAll('div')].find((div) =>
			isDepartureRoute(div.textContent),
		);

		return {
			value: element ? clean(element.textContent) : '',
			element: element || null,
		};
	}

	function getDestination(route) {
		const parts = upper(route).split('.').map(clean).filter(Boolean);

		const lastPart = parts[parts.length - 1] || '';
		const destination = lastPart.split('/')[0];

		return /^[A-Z]{4}$/.test(destination) ? destination : '';
	}

	function getValidAltitudes(direction) {
		const altitudes = [];

		if (direction === 'west') {
			for (let flightLevel = 0; flightLevel <= 400; flightLevel += 20) {
				altitudes.push(flightLevel);
			}

			for (let flightLevel = 430; flightLevel <= 600; flightLevel += 20) {
				altitudes.push(flightLevel);
			}
		}

		if (direction === 'east') {
			for (let flightLevel = 10; flightLevel <= 390; flightLevel += 20) {
				altitudes.push(flightLevel);
			}

			altitudes.push(410);

			for (let flightLevel = 450; flightLevel <= 610; flightLevel += 20) {
				altitudes.push(flightLevel);
			}
		}

		return altitudes;
	}

	function showNearestAltitudes(element, altitudes) {
		if (!element) {
			return;
		}

		const existing = element.parentElement.querySelector(
			'[data-kmem-altitude-hints="true"]',
		);

		if (existing) {
			existing.remove();
		}

		if (altitudes.length !== 2) {
			return;
		}

		const hint = document.createElement('span');
		hint.textContent = `${altitudes[0]} OR ${altitudes[1]}`;
		hint.dataset.kmemAltitudeHints = 'true';
		hint.style.fontWeight = '400';
		hint.style.marginLeft = '6px';
		hint.style.color = '#ef4444';
		hint.style.fontWeight = '700';

		element.after(hint);
	}

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

			if (parsedSID.sid && selectedValues.includes(upper(parsedSID.sid))) {
				sidElement = select;
			}

			if (parsedSID.sid && optionValues.includes(upper(parsedSID.sid))) {
				sidElement = select;
			}

			if (
				parsedSID.transition &&
				selectedValues.includes(upper(parsedSID.transition))
			) {
				transitionElement = select;
			}

			if (
				parsedSID.transition &&
				optionValues.includes(upper(parsedSID.transition))
			) {
				transitionElement = select;
			}
		}

		return {
			sidElement,
			transitionElement,
		};
	}

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

	function getSIDBase(sid) {
		return upper(sid).replace(/\d+$/, '');
	}

	function getSIDCycle(sid) {
		const base = getSIDBase(sid);

		return activeRules.sidCycles[base] ?? null;
	}

	function getCurrentSID(sid) {
		const base = getSIDBase(sid);
		const cycle = getSIDCycle(sid);

		return cycle === null ? sid : `${base}${cycle}`;
	}

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

	function getDepartureRule(sid, transition, equipment) {
		const sidBase = getSIDBase(sid);

		const restriction = activeRules.restrictedDepartures[sidBase];

		if (!equipment.rnav) {
			/* Resolve restricted departures before finding the ELVIS gate. */
			const departureBase = getSIDBase(restriction?.[0] || sidBase);
			const expectedTransition =
				activeRules.rvsmOnly.transitions[departureBase] || null;

			return {
				type: 'RNAV',
				validDeparture: upper(sid) === activeRules.rvsmOnly.departure,
				expectedDeparture:
					activeRules.rvsmOnly.departure +
					getSIDCycle(activeRules.rvsmOnly.departure),
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

	function parseFlightLevel(value) {
		const number = parseInt(value, 10);

		if (!Number.isFinite(number)) {
			return null;
		}

		return number;
	}

	/*
	 * Standard IFR hemispheric direction:
	 *
	 * Eastbound: odd
	 * Westbound: even
	 *
	 * We deliberately do not call this a definitive KMEM
	 * direction unless we can determine the destination.
	 */

	function altitudeParityCorrect(fl) {
		if (fl === null) {
			return null;
		}

		return fl % 2 === 1;
	}

	/*
	 * ============================================================
	 * VALIDATE CARD
	 * ============================================================
	 */

	async function validateCard(card) {
		restoreCard(card);

		const callsign = getCallsign(card);
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

		showSelectionHint(
			sidElements.sidElement,
			sidElements.transitionElement,
			getCurrentSID(departureRule.expectedDeparture),
			departureRule.expectedTransition,
		);

		const filedFlightLevel = parseFlightLevel(filedAltitude.value);

		const nonRvsmCeilingExceeded =
			!equipment.rvsm && filedFlightLevel !== null && filedFlightLevel > 290;

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
			showNearestAltitudes(
				filedAltitude.element,
				filedAltitudeValid === false ? nearestValidAltitudes : [],
			);

			const altitudeTitle = nonRvsmCeilingExceeded
				? `Filed altitude FL${filedAltitude.value} is invalid. Non-RVSM aircraft must remain at or below FL290.`
				: altitudeDirection
					? filedAltitudeValid
						? `Filed altitude FL${filedAltitude.value} is valid for ${altitudeDirection}bound traffic.`
						: `Filed altitude FL${filedAltitude.value} is invalid for ${altitudeDirection}bound traffic. Closest valid altitudes: FL${nearestValidAltitudes[0]} and FL${nearestValidAltitudes[1]}.`
					: `Filed altitude FL${filedAltitude.value}. Direction for destination ${destination || 'unknown'} could not be determined.`;

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
			const cards = findFlightCards();

			log(`Found ${cards.length} flight card(s).`);

			for (const card of cards) {
				try {
					await validateCard(card);
				} catch (error) {
					console.error(PREFIX, 'Failed to validate flight card:', error);
				}
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
		.then(() => Promise.all([loadRemoteRules(), loadRemotePlaneTypes()]))
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
