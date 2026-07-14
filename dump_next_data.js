const https = require('https');
const net = require('net');
const fs = require('fs');

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
            buffer = '';
            
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
            fs.writeFileSync('C:/Users/772wa/.gemini/antigravity/scratch/patheticcg_next_data.json', match[1]);
            console.log('Successfully wrote patheticcg_next_data.json!');
            success = true;
            break;
          }
        }
      } catch (err) {
        // ignore
      }
    }
    if (!success) {
      console.log('Failed to fetch patheticcg_next_data.');
    }
  } catch (err) {
    console.error(err);
  }
}

run();
