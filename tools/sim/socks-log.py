#!/usr/bin/env python3
"""Stand-in for Orbot's bypass port: a SOCKS5 proxy on 127.0.0.1 that logs
every CONNECT and relays it directly. Usage: socks-log.py PORT LOGFILE"""
import asyncio, socket, struct, sys, time

PORT = int(sys.argv[1]); LOG = open(sys.argv[2], 'a', buffering=1)

def log(msg):
    LOG.write('%s %s\n' % (time.strftime('%H:%M:%S'), msg))

async def pipe(r, w):
    try:
        while True:
            data = await r.read(65536)
            if not data: break
            w.write(data); await w.drain()
    except Exception:
        pass
    finally:
        try: w.close()
        except Exception: pass

async def handle(r, w):
    try:
        ver, n = await r.readexactly(2)
        await r.readexactly(n)
        w.write(b'\x05\x00'); await w.drain()
        ver, cmd, _, atyp = await r.readexactly(4)
        if atyp == 1:
            host = socket.inet_ntop(socket.AF_INET, await r.readexactly(4))
        elif atyp == 4:
            host = socket.inet_ntop(socket.AF_INET6, await r.readexactly(16))
        elif atyp == 3:
            host = (await r.readexactly((await r.readexactly(1))[0])).decode()
        else:
            w.close(); return
        port = struct.unpack('>H', await r.readexactly(2))[0]
        if cmd != 1:
            log('REFUSED cmd %d %s:%d' % (cmd, host, port))
            w.write(b'\x05\x07\x00\x01' + b'\x00' * 6); w.close(); return
        try:
            ur, uw = await asyncio.wait_for(asyncio.open_connection(host, port), 20)
        except Exception as e:
            log('FAILED %s:%d %s' % (host, port, type(e).__name__))
            w.write(b'\x05\x05\x00\x01' + b'\x00' * 6); w.close(); return
        log('CONNECT %s:%d' % (host, port))
        w.write(b'\x05\x00\x00\x01' + b'\x00' * 6); await w.drain()
        await asyncio.gather(pipe(r, uw), pipe(ur, w))
    except Exception:
        try: w.close()
        except Exception: pass

async def main():
    server = await asyncio.start_server(handle, '127.0.0.1', PORT)
    log('listening on %d' % PORT)
    async with server:
        await server.serve_forever()

asyncio.run(main())
