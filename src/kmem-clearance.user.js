// ==UserScript==
// @name         KMEM vTDLS Flight Plan Validator
// @namespace    https://vectorartcc.com/
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

	const PREFIX = '[KMEM Validator]';

	/*
	 * ============================================================
	 * VECTOR ARTCC KMEM RULES
	 * ============================================================
	 */

	const MEM_RULES = {
		departureFrequency: '125.8',

		jetInitialAltitude: 5000,

		propInitialAltitude: 3000,

		restrictedDepartures: {
			AUTMN: ['CHLDR5', 'ANSWA'],
			BINKY: ['PIEPE6', 'IBUFY'],
			GENEH: ['CRSON7', 'HUMMS'],
			GMBUD: ['BBKING7', 'KERMI'],
			GRRIZ: ['JTEEE5', 'ODATE'],
			HOTRD: ['ZUMIT', 'JTEEE'],
			NIKEI: ['ZUMIT', 'FOXOM'],
			OLEMS: ['PIEPE6', 'IBUFY'],
		},

		rvsmOnly: {
			departure: 'ELVIS4',

			transitions: {
				AZONE: 'ETWOO',
				BBKND: 'ETREE',
				CHLDR: 'EONEE',
				CRSON: 'NFOUR',
				DUCKZ: 'WTWOO',
				GOETZ: 'EONEE',
				JTEEE: 'NTWOO',
				PIEPE: 'STWOO',
				SELPH: 'NTREE',
				ZUMIT: 'WTREE',
				AUTMN: 'SFOUR',
				BINKY: 'STREE',
				GENEH: 'NFIVE',
				GMBUD: 'EFOUR',
				GRRIZ: 'NRONE',
				HOTRD: 'WFIVE',
				NIKEI: 'WFOUR',
				OLEMS: 'SONEI',
			},
		},

		/*
		 * SID cycle information from the Vector validator.
		 */
		currentCycles: {
			AZONE: 7,
			BBKING: 7,
			CHLDR: 5,
			CRSON: 7,
			DUCKZ: 5,
			ELVIS: 4,
			GOETZ: 7,
			JTEEE: 5,
			PIEPE: 6,
			SELPH: 7,
			ZUMIT: 5,
		},
	};

	const AIRPORT_API = 'https://ryanburnette.github.io/airports-api/icao/';

	const airportCache = new Map();

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

	function log(...args) {
		console.log(PREFIX, ...args);
	}

	function warn(...args) {
		console.warn(PREFIX, ...args);
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

			if (!/^KMEM\./i.test(text)) {
				continue;
			}

			let current = div;

			for (let i = 0; i < 10 && current; i++) {
				const currentText = clean(current.textContent);

				const aircraft = [...current.querySelectorAll('span')].find((span) =>
					/^[A-Z0-9]{2,8}\/[A-Z]$/i.test(clean(span.textContent)),
				);

				const selects = current.querySelectorAll('select').length;

				const cancel = [...current.querySelectorAll('button')].some(
					(button) => upper(button.textContent) === 'CANCEL',
				);

				if (aircraft && selects >= 5 && cancel && /KMEM\./i.test(currentText)) {
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
			/^KMEM\./i.test(clean(div.textContent)),
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

		/*
		 * Airbus
		 */
		if (/^A[1234]\d\d$/.test(t)) {
			return 'JET';
		}

		if (/^A\d{2}N$/.test(t)) {
			return 'JET';
		}

		/*
		 * Boeing
		 */
		if (/^B\d{3}$/.test(t)) {
			return 'JET';
		}

		if (/^B7[0-9]{2}$/.test(t)) {
			return 'JET';
		}

		if (/^B[3579][0-9][A-Z]$/.test(t)) {
			return 'JET';
		}

		/*
		 * McDonnell Douglas
		 */
		if (/^MD\d/.test(t)) {
			return 'JET';
		}

		if (/^DC\d/.test(t)) {
			return 'JET';
		}

		/*
		 * Regional jets
		 */
		if (/^CRJ/.test(t)) {
			return 'JET';
		}

		if (/^E1\d/.test(t)) {
			return 'JET';
		}

		if (/^E2\d/.test(t)) {
			return 'JET';
		}

		/*
		 * Common business jets.
		 */
		if (/^(GLF|GULF|CL|C56|C5|F2|FA|H25|LJ|BE4)/.test(t)) {
			return 'JET';
		}

		if (/^(C1|C2|C3|BE\d|PC\d|PA\d|DA\d|AT\d|DHC|DH8|SF34|JS3)/.test(t)) {
			return 'PROP';
		}

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
			/^KMEM\./i.test(clean(div.textContent)),
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
		hint.textContent = ` [${altitudes[0]}, ${altitudes[1]}]`;
		hint.dataset.kmemAltitudeHints = 'true';
		hint.style.fontWeight = '400';
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
			const value = upper(
				select.value || select.options?.[select.selectedIndex]?.text,
			);
			const optionValues = [...select.options].map((option) =>
				upper(option.value || option.text),
			);

			if (parsedSID.sid && value === upper(parsedSID.sid)) {
				sidElement = select;
			}

			if (parsedSID.sid && optionValues.includes(upper(parsedSID.sid))) {
				sidElement = select;
			}

			if (parsedSID.transition && value === upper(parsedSID.transition)) {
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

		return MEM_RULES.currentCycles[base] ?? null;
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

		/* Non-RNAV aircraft must use ELVIS4. */

		if (!equipment.rnav) {
			const expectedTransition =
				MEM_RULES.rvsmOnly.transitions[sidBase] || null;

			return {
				type: 'RNAV',
				validDeparture: upper(sid) === MEM_RULES.rvsmOnly.departure,
				expectedDeparture: MEM_RULES.rvsmOnly.departure,
				expectedTransition,
				validTransition: expectedTransition
					? upper(transition) === upper(expectedTransition)
					: true,
			};
		}

		/*
		 * Normal restricted departure mapping.
		 */

		const restriction = MEM_RULES.restrictedDepartures[sidBase];

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
			getAirportInfo('KMEM'),
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

		/*
		 * --------------------------------------------------------
		 * Initial altitude
		 * --------------------------------------------------------
		 */

		const expectedInitialAltitude =
			aircraftCategory === 'JET'
				? MEM_RULES.jetInitialAltitude
				: aircraftCategory === 'PROP'
					? MEM_RULES.propInitialAltitude
					: null;

		const initialAltitudeValid =
			expectedInitialAltitude !== null &&
			initialAltitude.feet === expectedInitialAltitude;

		const departureFrequencyValid =
			departureFrequency.value === MEM_RULES.departureFrequency;

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
				departureFrequencyValid
					? `Departure frequency ${MEM_RULES.departureFrequency} is correct.`
					: `Expected departure frequency ${MEM_RULES.departureFrequency}.`,
			);
		}

		/*
		 * SID
		 */

		const sidElement = sidElements.sidElement || route.element;

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
		const cards = findFlightCards();

		log(`Found ${cards.length} flight card(s).`);

		for (const card of cards) {
			try {
				await validateCard(card);
			} catch (error) {
				console.error(PREFIX, 'Failed to validate flight card:', error);
			}
		}
	}

	function scheduleScan() {
		clearTimeout(scanTimer);

		scanTimer = setTimeout(scan, 150);
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

	log('KMEM vTDLS validator loaded.');

	scan();

	setTimeout(scan, 500);
	setTimeout(scan, 1500);
	setTimeout(scan, 3000);
})();
