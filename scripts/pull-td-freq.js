const DEPARTURE_AIRPORT = 'KMEM';
const API_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
const VATSIM_AIRPORT_API = 'https://my.vatsim.net/api/v2/aip/airports/';
let onlineFrequencyRequest = null;

async function getAirportStations() {
	const response = await fetch(`${VATSIM_AIRPORT_API}${DEPARTURE_AIRPORT}`);

	if (!response.ok) {
		throw new Error(`Airport request failed (${response.status}).`);
	}

	const { data } = await response.json();
	return data?.stations ?? [];
}

function normalizeStationCallsign(callsign) {
	const parts = callsign.toUpperCase().split('_');
	return parts.length >= 2
		? `${parts[0]}_${parts.at(-1)}`
		: callsign.toUpperCase();
}

async function getOnlineAirportFrequency() {
	if (!onlineFrequencyRequest) {
		onlineFrequencyRequest = Promise.all([
			getAirportStations(),
			fetch(API_URL, { cache: 'no-store' }).then((response) => {
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
				onlineFrequencyRequest = null;
				throw error;
			});
	}

	return onlineFrequencyRequest;
}

getOnlineAirportFrequency()
	.then((frequency) =>
		console.log(frequency ?? 'No online airport controller.'),
	)
	.catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
