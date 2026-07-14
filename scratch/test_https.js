const https = require('https');

setTimeout(() => {
  const req = https.get('https://grimore.gg/', { rejectUnauthorized: false }, (res) => {
    console.log("HTTPS Response status code:", res.statusCode);
    console.log("HTTPS Response headers:", res.headers);
  });

  req.on('error', (err) => {
    console.error("HTTPS Request Error:", err);
  });
}, 5000); // Wait 5 seconds for SSL generation
