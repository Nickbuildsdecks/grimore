const https = require('https');
const net = require('net');

function decodeChunked(body) {
  let result = '';
  let index = 0;
  while (index < body.length) {
    const nextLine = body.indexOf('\r\n', index);
    if (nextLine === -1) break;
    const sizeStr = body.substring(index, nextLine).trim();
    if (sizeStr === '') {
      index = nextLine + 2;
      continue;
    }
    const size = parseInt(sizeStr, 16);
    if (isNaN(size) || size === 0) break;
    result += body.substring(nextLine + 2, nextLine + 2 + size);
    index = nextLine + 2 + size + 2;
  }
  return result || body;
}

function fetchWithProxyHttps(host, path, proxy) {
  return new Promise((resolve, reject) => {
    const [proxyHost, proxyPort] = proxy.split(':');
    const socket = net.connect(Number(proxyPort), proxyHost, () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });

    let buffer = '';
    let connected = false;

    socket.on('data', (chunk) => {
      if (!connected) {
        buffer += chunk.toString('binary');
        if (buffer.includes('\r\n\r\n')) {
          if (buffer.startsWith('HTTP/1.1 200') || buffer.startsWith('HTTP/1.0 200')) {
            connected = true;
            buffer = ''; // clear buffer
            
            const tls = require('tls');
            const tlsSocket = tls.connect({
              socket: socket,
              servername: host,
              rejectUnauthorized: false
            }, () => {
              tlsSocket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8\r\nConnection: close\r\n\r\n`);
            });

            let tlsBuffer = '';
            tlsSocket.on('data', (tlsChunk) => {
              tlsBuffer += tlsChunk.toString('binary');
            });
            tlsSocket.on('end', () => {
              resolve(tlsBuffer);
            });
            tlsSocket.on('error', reject);
          } else {
            socket.destroy();
            reject(new Error('Proxy connection failed: ' + buffer.substring(0, 100)));
          }
        }
      }
    });

    socket.on('error', reject);
  });
}

async function run() {
  try {
    console.log('Fetching proxy list...');
    const proxies = await new Promise((resolve, reject) => {
      https.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=yes&anonymity=all', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve(data.split('\r\n').filter(p => p.trim() !== ''));
        });
      }).on('error', reject);
    });
    console.log(`Fetched ${proxies.length} proxies.`);

    const host = 'moxfield.com';
    const path = `/users/PatheticCG`;
    
    let success = false;
    for (let i = 0; i < Math.min(proxies.length, 30); i++) {
      const proxy = proxies[i];
      console.log(`Attempting fetch via proxy ${proxy}...`);
      try {
        const rawRes = await fetchWithProxyHttps(host, path, proxy);
        const headerEnd = rawRes.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        
        const headers = rawRes.substring(0, headerEnd);
        const body = rawRes.substring(headerEnd + 4);
        
        if (headers.includes('200 OK')) {
          const cleanBody = decodeChunked(body);
          
          const match = cleanBody.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
          if (match) {
            console.log('Found __NEXT_DATA__ script!');
            const parsed = JSON.parse(match[1]);
            const pageProps = parsed.props?.pageProps;
            if (pageProps) {
              console.log('Keys of pageProps:', Object.keys(pageProps));
              // Let's print out the structure of all pageProps keys to find the decks
              for (const key of Object.keys(pageProps)) {
                console.log(`Key "${key}" type:`, typeof pageProps[key]);
                if (pageProps[key] && typeof pageProps[key] === 'object') {
                  console.log(`Key "${key}" subkeys:`, Object.keys(pageProps[key]).slice(0, 10));
                  if (Array.isArray(pageProps[key])) {
                    console.log(`Key "${key}" is array with length:`, pageProps[key].length);
                    console.log(`Sample item in "${key}":`, pageProps[key][0]);
                  }
                  // Check deeper
                  const val = pageProps[key];
                  for (const subkey of Object.keys(val)) {
                    if (val[subkey] && typeof val[subkey] === 'object') {
                      console.log(`  Subkey "${subkey}" type:`, typeof val[subkey]);
                      if (Array.isArray(val[subkey])) {
                        console.log(`  Subkey "${subkey}" is array with length:`, val[subkey].length);
                        console.log(`  Sample item in subkey "${subkey}":`, val[subkey][0]);
                      } else {
                        console.log(`  Subkey "${subkey}" subkeys:`, Object.keys(val[subkey]).slice(0, 10));
                        // Check if it's paginated decks
                        if (val[subkey].data && Array.isArray(val[subkey].data)) {
                          console.log(`    Found data array under subkey "${subkey}" with length:`, val[subkey].data.length);
                          console.log(`    Sample deck in "${subkey}.data":`, val[subkey].data[0]);
                        }
                      }
                    }
                  }
                }
              }
            } else {
              console.log('pageProps not found on parsed Next.js data.');
            }
            success = true;
            break;
          } else {
            console.log('__NEXT_DATA__ tag not found in body.');
          }
        }
      } catch (err) {
        // ignore
      }
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

run();
