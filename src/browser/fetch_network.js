import { LOG_FETCH } from "../const.js";
import { dbg_log } from "../log.js";

const WEBSOCKET_SEC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

import {
    create_eth_encoder_buf,
    handle_fake_networking,
    TCPConnection,
    TCP_STATE_SYN_RECEIVED,
    fake_tcp_connect,
    fake_tcp_probe
} from "./fake_network.js";

// For Types Only
import { BusConnector } from "../bus.js";

/**
 * @constructor
 *
 * @param {BusConnector} bus
 * @param {*=} config
 */
export function FetchNetworkAdapter(bus, config)
{
    config = config || {};
    this.bus = bus;
    this.id = config.id || 0;
    this.router_mac = new Uint8Array((config.router_mac || "52:54:0:1:2:3").split(":").map(function(x) { return parseInt(x, 16); }));
    this.router_ip = new Uint8Array((config.router_ip || "192.168.86.1").split(".").map(function(x) { return parseInt(x, 10); }));
    this.vm_ip = new Uint8Array((config.vm_ip || "192.168.86.100").split(".").map(function(x) { return parseInt(x, 10); }));
    this.masquerade = config.masquerade === undefined || !!config.masquerade;
    this.vm_mac = new Uint8Array(6);
    this.dns_method = config.dns_method || "static";
    this.doh_server = config.doh_server;
    this.tls_ca_cert = config.tls_ca_cert;
    this.tls_private_key = config.tls_private_key;
    this.tls_public_key = config.tls_public_key;

    this.tcp_conn = {};
    this.mtu = config.mtu;
    this.eth_encoder_buf = create_eth_encoder_buf(this.mtu);
    this.fetch = (...args) => fetch(...args);

    // Ex: 'https://corsproxy.io/?'
    this.cors_proxy = config.cors_proxy;

    this.bus.register("emulator-started", () => {
        if(globalThis["TLS"]) {
            globalThis["TLS"]().then(mod => {
                this.tls = new mod["MITM"]();
                if(!this.tls_private_key) {
                    this.tls["generateECCPrivateKey"]();
                    this.tls_private_key = this.tls["getPrivateKey"]();
                    this.tls_ca_cert = this.tls["getCACertificate"]();
                } else {
                    this.tls["setPrivateKey"](this.tls_private_key);
                    this.tls["setCACertificate"](this.tls_ca_cert);
                }
            });
        } else {
            dbg_log("No TLS library detected.", LOG_FETCH);
        }
    }, this);


    this.bus.register("net" + this.id + "-mac", function(mac) {
        this.vm_mac = new Uint8Array(mac.split(":").map(function(x) { return parseInt(x, 16); }));
    }, this);
    this.bus.register("net" + this.id + "-send", function(data)
    {
        this.send(data);
    }, this);
    this.bus.register("tcp-connection", (conn) => {
        if(conn.sport === 80) {
            conn.on("data", on_data_http);
            conn.accept();
        }
        if(conn.sport === 443 && this.tls) {
            conn.on("data", on_data_tls.bind(conn, {net: this}));
            conn.accept();
        }
    }, this);
}

FetchNetworkAdapter.prototype.destroy = function()
{
};

FetchNetworkAdapter.prototype.connect = function(port)
{
    return fake_tcp_connect(port, this);
};

FetchNetworkAdapter.prototype.tcp_probe = function(port)
{
    return fake_tcp_probe(port, this);
};

/**
* @this {TCPConnection}
* @param {!ArrayBuffer} data
*/
async function on_data_http(data)
{
    if(this.ws) {
        return on_data_websocket.call(this, data);
    }

    this.read = this.read || "";
    this.read += new TextDecoder().decode(data);
    if(this.read && this.read.indexOf("\r\n\r\n") !== -1) {
        let offset = this.read.indexOf("\r\n\r\n");
        let headers = this.read.substring(0, offset).split(/\r\n/);
        let data = this.read.substring(offset + 4);
        this.read = "";

        let first_line = headers[0].split(" ");
        let target;
        if(/^https?:/.test(first_line[1])) {
            // HTTP proxy
            target = new URL(first_line[1]);
        }
        else {
            target = new URL("http://host" + first_line[1]);
        }
        if(typeof window !== "undefined" && target.protocol === "http:" && window.location.protocol === "https:") {
            // fix "Mixed Content" errors
            target.protocol = "https:";
        }
        else if(this.tls) {
            target.protocol = "https:";
        }

        let req_headers = new Headers();
        for(let i = 1; i < headers.length; ++i) {
            const header = this.net.parse_http_header(headers[i]);
            if(!header) {
                console.warn('The request contains an invalid header: "%s"', headers[i]);
                this.net.respond_text_and_close(this, 400, "Bad Request", `Invalid header in request: ${headers[i]}`);
                return;
            }
            if( header.key.toLowerCase() === "host" ) target.host = header.value;
            else req_headers.append(header.key, header.value);
        }

        if(!this.net.cors_proxy && /^\d+\.external$/.test(target.hostname)) {
            dbg_log("Request to localhost: " + target.href, LOG_FETCH);
            const localport = parseInt(target.hostname.split(".")[0], 10);
            if(!isNaN(localport) && localport > 0 && localport < 65536) {
                target.protocol = "http:";
                target.hostname = "localhost";
                target.port = localport.toString(10);
            } else {
                console.warn('Unknown port for localhost: "%s"', target.href);
                this.net.respond_text_and_close(this, 400, "Bad Request", `Unknown port for localhost: ${target.href}`);
                return;
            }
        }

        if(req_headers.get("upgrade") === "websocket") {
            const data = new TextEncoder().encode(req_headers.get("Sec-WebSocket-Key") + WEBSOCKET_SEC_GUID);
            const hashBytes = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
            let binary = "";
            for(let i = 0; i < hashBytes.length; i++) {
                binary += String.fromCharCode(hashBytes[i]);
            }

            const headers = new Headers({
                "Sec-WebSocket-Accept": globalThis.btoa(binary),
                "upgrade": "websocket",
                "connection": "upgrade"
            });

            target.protocol = target.protocol.replace("http", "ws");
            this.ws = new WebSocket(target.toString());
            this.on("close", () => this.ws.close());

            this.ws.addEventListener("open", (e) => {
                console.log("WebSocket Connection Opened");
                this.writev([this.net.form_response_head(101, "Switching Protocol", headers)]);
            });

            this.ws.addEventListener("message", async (e) => {
                console.log(`RECEIVED: ${e.data}`);
                if(e.data instanceof Blob) {
                    console.log("ITS A BLOB", e.data);
                    write_ws_frame(this, 2,  await e.data.arrayBuffer());
                } else {
                    write_ws_frame(this, 1, new TextEncoder().encode(e.data));
                }
            });

            return;
        }

        dbg_log("HTTP Dispatch: " + target.href, LOG_FETCH);

        this.name = target.href;
        let opts = {
            method: first_line[0],
            headers: req_headers,
        };
        if(["put", "post"].indexOf(opts.method.toLowerCase()) !== -1) {
            opts.body = data;
        }

        const fetch_url = this.net.cors_proxy ? this.net.cors_proxy + encodeURIComponent(target.href) : target.href;
        const encoder = new TextEncoder();
        let response_started = false;
        let handler = (resp) => {
            let resp_headers = new Headers(resp.headers);
            resp_headers.delete("content-encoding");
            resp_headers.delete("keep-alive");
            resp_headers.delete("content-length");
            resp_headers.delete("transfer-encoding");
            resp_headers.set("x-was-fetch-redirected", `${!!resp.redirected}`);
            resp_headers.set("x-fetch-resp-url", resp.url);
            resp_headers.set("connection", "close");

            this.write(this.net.form_response_head(resp.status, resp.statusText, resp_headers));
            response_started = true;

            if(resp.body && resp.body.getReader) {
                const resp_reader = resp.body.getReader();
                const pump = ({ value, done }) => {
                    if(value) {
                        this.write(value);
                    }
                    if(done) {
                        this.close();
                    }
                    else {
                        return resp_reader.read().then(pump);
                    }
                };
                resp_reader.read().then(pump);
            } else {
                resp.arrayBuffer().then(buffer => {
                    this.write(new Uint8Array(buffer));
                    this.close();
                });
            }
        };

        if(this.net.tls && /^https?:[/][/]mitm[.]it[/](ca|cert)[/.]pem/.test(target.href)) {
            return handler(new Response(this.net.tls_ca_cert));
        }

        this.net.fetch(fetch_url, opts).then(handler)
        .catch((e) => {
            console.warn("Fetch Failed: " + fetch_url + "\n" + e);
            if(!response_started) {
                this.net.respond_text_and_close(this, 502, "Fetch Error", `Fetch ${fetch_url} failed:\n\n${e.stack || e.message}`);
            }
            this.close();
        });
    }
}

/**
 * @param {Uint8Array} buf
 * @returns {{opcode: number, data: Uint8Array}}
 */
function parseWebSocketFrame(buf) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const firstByte = view.getUint8(0);
    const secondByte = view.getUint8(1);
    const opcode = firstByte & 0x0f;
    let offset = 2;

    let payloadLength = secondByte & 0x7f;

    if(payloadLength === 126) {
        payloadLength = view.getUint16(offset);
        offset += 2;
    } else if(payloadLength === 127) {
        const high = view.getUint32(offset);
        const low  = view.getUint32(offset + 4);
        offset += 8;
        payloadLength = high << 8 + low;
    }

    let mask = [0, 0, 0, 0];
    if((secondByte & 0x80) !== 0) {
        mask = new Uint8Array(buf.buffer, buf.byteOffset + offset, 4);
        offset += 4;
    }

    let data = new Uint8Array(payloadLength);
    for(let i = 0; i < payloadLength; i++) {
        data[i] = view.getUint8(offset + i) ^ mask[i % 4];
    }

    return {
        opcode,
        data
    };
}

/**
* @this {TCPConnection}
* @param {!ArrayBuffer} data
*/
async function on_data_websocket(data)
{
    let frame = parseWebSocketFrame(new Uint8Array(data));

    if(frame.opcode === 1) {
        this.ws.send(new TextDecoder().decode(frame.data.buffer));
    } else if(frame.opcode === 2) {
        this.ws.send(frame.data);
    } else if(frame.opcode === 8) {
        console.log("WebSocket Close Frame Received");
        this.close();
    } else if(frame.opcode === 9) {
        console.log("WebSocket Ping Frame Received");
        write_ws_frame(this, 10, frame.data);
    } else if(frame.opcode === 10) {
        console.log("WebSocket Pong Frame Received");
    } else {
        console.warn("Unknown WebSocket Opcode:", frame.opcode);
    }
}

async function write_ws_frame(conn, opcode, payload)
{
    const frame = new ArrayBuffer(10);
    const view = new DataView(frame);
    const frameBytes = new Uint8Array(frame);

    view.setUint8(0, 0x80 | (opcode & 0x0f));

    let offset = 2;
    let secondByte = 0;
    let payloadLen = payload.length;

    if(payloadLen < 126) {
        secondByte |= payloadLen;
    } else if(payloadLen <= 0xffff) {
        secondByte |= 126;
        view.setUint16(offset, payloadLen);
        offset += 2;
    } else {
        secondByte |= 127;
        view.setUint32(offset, 0); offset += 4;
        view.setUint32(offset, payloadLen >>> 0);  offset += 4;
    }
    view.setUint8(1, secondByte);
    conn.writev([frameBytes.slice(0, offset), payload]);
}

async function on_data_tls(ctx, data)
{
    let packet = this;
    if(!ctx.tls) {
        ctx.tls = packet.net.tls["ssl"]();
        ctx.write = d => {
            let r = ctx.tls["dataIn"](d);
        };
        ctx.writev = v => {
            for(const data of v) {
                let r = ctx.tls["dataIn"](data);
            }
        };
        ctx.close = () => {
            ctx.tls["close"]();
            setTimeout(()=> packet.close(), 100);
        };

        ctx.tls["setPacketOutCallback"](d => {
            let r = packet.write(d);
        });

        ctx.tls["setDataOutCallback"](d => {
            on_data_http.call(ctx, d);
        });
    }
    ctx.tls["packetIn"](data);
}

FetchNetworkAdapter.prototype.fetch = async function(url, options)
{
    if(this.cors_proxy) url = this.cors_proxy + encodeURIComponent(url);

    try
    {
        const resp = await fetch(url, options);
        const ab = await resp.arrayBuffer();
        return [resp, ab];
    }
    catch(e)
    {
        console.warn("Fetch Failed: " + url + "\n" + e);
        return [
            {
                status: 502,
                statusText: "Fetch Error",
                headers: new Headers({ "Content-Type": "text/plain" }),
            },
            new TextEncoder().encode(`Fetch ${url} failed:\n\n${e.stack}`).buffer
        ];
    }
};

FetchNetworkAdapter.prototype.form_response_head = function(status_code, status_text, headers)
{
    let lines = [
        `HTTP/1.1 ${status_code} ${status_text}`
    ];

    for(const [key, value] of headers.entries()) {
        lines.push(`${key}: ${value}`);
    }

    return new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n");
};

FetchNetworkAdapter.prototype.respond_text_and_close = function(conn, status_code, status_text, body)
{
    const headers = new Headers({
        "content-type": "text/plain",
        "content-length": body.length.toString(10),
        "connection": "close"
    });
    conn.writev([this.form_response_head(status_code, status_text, headers), new TextEncoder().encode(body)]);
    conn.close();
};

FetchNetworkAdapter.prototype.parse_http_header = function(header)
{
    const parts = header.match(/^([^:]*):(.*)$/);
    if(!parts) {
        dbg_log("Unable to parse HTTP header", LOG_FETCH);
        return;
    }

    const key = parts[1];
    const value = parts[2].trim();

    if(key.length === 0)
    {
        dbg_log("Header key is empty, raw header", LOG_FETCH);
        return;
    }
    if(value.length === 0)
    {
        dbg_log("Header value is empty", LOG_FETCH);
        return;
    }
    if(!/^[\w-]+$/.test(key))
    {
        dbg_log("Header key contains forbidden characters", LOG_FETCH);
        return;
    }
    if(!/^[\x20-\x7E]+$/.test(value))
    {
        dbg_log("Header value contains forbidden characters", LOG_FETCH);
        return;
    }

    return { key, value };
};

/**
 * @param {Uint8Array} data
 */
FetchNetworkAdapter.prototype.send = function(data)
{
    handle_fake_networking(data, this);
};

/**
 * @param {Uint8Array} data
 */
FetchNetworkAdapter.prototype.receive = function(data)
{
    this.bus.send("net" + this.id + "-receive", new Uint8Array(data));
};
