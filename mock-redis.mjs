// Mock Upstash Redis REST server — file-backed so state survives restarts/multiple processes
import http from 'http';
import fs from 'fs';
const FILE = 'mock-store.json';
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const write = (m) => fs.writeFileSync(FILE, JSON.stringify(m));

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const m = read();
    m['_last_body'] = body.slice(0, 300);
    const out = [];
    try {
      for (const cmd of JSON.parse(body || '[]')) {
        const [op, key, val] = cmd;
        m['_cmd_' + (out.length)] = op + ' ' + key;
        if (op === 'GET') out.push({ result: key in m ? m[key] : null });
        else if (op === 'SET') { m[key] = val; out.push({ result: 'OK' }); }
        else out.push({ error: 'unsupported ' + op });
      }
    } catch (e) { m['_error'] = e.message; }
    write(m);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out));
  });
}).listen(3998, () => console.log('file-backed mock redis on 3998'));
