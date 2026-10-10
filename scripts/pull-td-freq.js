const https = require('https');

const API_URL = 'https://data.vatsim.net/v3/vatsim-data.json';

function getfreqList() {
	return new Promise((resolve, reject) => {
		https
			.get(API_URL, (res) => {
				let data = '';

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					try {
						const vatsim = JSON.parse(data);

						const frequencies = vatsim.controllers
							.filter((controller) => {
								const callsign = controller.callsign.toUpperCase();

								return (
									(callsign.startsWith('ZME_') ||
										callsign.startsWith('MXX_') ||
										callsign.startsWith('MEM_')) &&
									!callsign.endsWith('_GND')
								);
							})
							.sort(
								(a, b) =>
									Number(a.facility) - Number(b.facility) ||
									a.callsign.localeCompare(b.callsign),
							)
							.map((controller) => controller.frequency);

						resolve(frequencies);
					} catch (error) {
						reject(new Error('Failed to parse VATSIM data.', { cause: error }));
					}
				});
			})
			.on('error', (error) => {
				reject(new Error('Failed to connect to VATSIM.', { cause: error }));
			});
	});
}

getfreqList()
	.then((frequencies) => console.log(JSON.stringify(frequencies)))
	.catch((error) => console.error(error.message));
