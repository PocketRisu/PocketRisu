'use strict';

// Backup uploads run with timeouts off. A client that vanished without
// closing its connection would leave the route waiting for ever, and as a
// counted write that is never released (server.cjs checkActiveSession,
// replacesData) it would hold every page boot back. watchUploadStall cuts such
// an upload off once the client has sent nothing for stallMs.
//
// The server can be the slow side instead: while it works through a part of
// the backup it reads nothing, and the client's bytes wait in the request's
// buffer or on the socket. Bytes waiting there, or read from the socket since
// the last check, count as the client sending. A long synchronous step can
// also end with this timer running before the socket is read again, so a cut
// first lets one round of pending I/O in and checks again.
function watchUploadStall(req, stallMs) {
    let lastActivityAt = Date.now();
    let bytesReadSeen = socketBytesRead();
    let stopped = false;

    function socketBytesRead() {
        return req.socket ? req.socket.bytesRead : 0;
    }
    function clientSent() {
        const bytesRead = socketBytesRead();
        const moved = bytesRead !== bytesReadSeen;
        bytesReadSeen = bytesRead;
        return moved || req.readableLength > 0;
    }
    function stalled() {
        if (clientSent()) lastActivityAt = Date.now();
        return Date.now() - lastActivityAt >= stallMs;
    }

    const timer = setInterval(() => {
        if (req.complete) {
            clearInterval(timer);
            return;
        }
        if (!stalled()) return;
        setImmediate(() => {
            if (stopped || req.complete || req.destroyed || !stalled()) return;
            clearInterval(timer);
            req.destroy(new Error('Backup upload stalled'));
        });
    }, Math.min(stallMs, 10 * 1000));
    timer.unref();

    return {
        received: () => { lastActivityAt = Date.now(); },
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
}

module.exports = { watchUploadStall };
