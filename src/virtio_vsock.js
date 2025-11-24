import { LOG_PCI } from "./const.js";
import { dbg_log } from "./log.js";
import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import * as marshall from "../lib/marshall.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

const VIRTIO_VSOCK_F_STREAM = 0;
const VIRTIO_VSOCK_F_SEQPACKET = 1;

// https://docs.oasis-open.org/virtio/virtio/v1.2/csd01/virtio-v1.2-csd01.html#x1-2900003

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function VirtioVSock(cpu, bus)
{
    /** @const @type {BusConnector} */
    this.bus = bus;

    const queues = [
        {size_supported: 32, notify_offset: 0},
        {size_supported: 32, notify_offset: 1},
        {size_supported: 2, notify_offset: 2}
    ];

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-vsock",
        pci_id: 0x0D << 3,
        device_id: 0x1040 + 19,
        subsystem_device_id: 19,
        common:
        {
            initial_port: 0xE800,
            queues: queues,
            features:
            [
                VIRTIO_F_VERSION_1,
                VIRTIO_VSOCK_F_STREAM,
                VIRTIO_VSOCK_F_SEQPACKET,
            ],
            on_driver_ok: () => {
                dbg_log("VSock setup", LOG_PCI);
            },
        },
        notification:
        {
            initial_port: 0xE900,
            single_handler: false,
            handlers:
            [
                (queue_id) =>
                {

                },
                (queue_id) =>
                {
                    const queue = this.virtio.queues[queue_id];

                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);

                        const parts = marshall.Unmarshall(["d", "d", "w", "w", "w", "h", "h", "w", "w", "w"], buffer, { offset : 0 });
                        let type = parts[5];
                        let op = parts[6];
                        let flags = parts[7];
                        let payload = buffer.subarray(44);
                        const response = new Uint8Array(bufchain.length_readable);

                        if(op === 1) {
                            // Just accept all connections for now
                            this.send_op(parts[1], parts[0], parts[3], parts[2], 2);
                        }
                        if(op === 5) {
                            this.bus.send("vsock-recv", { src_cid: parts[0], dst_cid: parts[1], src_port: parts[2], dst_port: parts[3], data: payload });
                        }
                        queue.push_reply(bufchain);
                    }
                    queue.flush_replies();
                },
                (queue_id) =>
                {

                },
            ],
        },
        isr_status:
        {
            initial_port: 0xE700,
        },
        device_specific:
        {
            initial_port: 0xE600,
            struct:
            [
                {
                    bytes: 4,
                    name: "guest_cid",
                    read: () => {
                        return 3;
                    },
                    write: data => { /* read only */ },
                },
           ]
        },
    });

    this.bus.register("vsock-op", (data) => {
        this.send_op(data.src_cid, data.dst_cid, data.dst_port, data.src_port, data.data);
    }, this);

    this.bus.register("vsock-send", (data) => {
        this.send(data.src_cid, data.dst_cid, data.dst_port, data.src_port, data.data);
    }, this);
}


VirtioVSock.prototype.get_state = function()
{
    const state = [];
    state[0] = this.virtio;
    return state;
};

VirtioVSock.prototype.set_state = function(state)
{
    if(state) {
        this.virtio.set_state(state[0]);
    }
};

VirtioVSock.prototype.send_op = function (src_id, dst_id, src_port, dst_port, op) {
    const with_header = new Uint8Array(44);
    marshall.Marshall(["d", "d", "w", "w", "w", "h", "h", "w", "w", "w"], [
        src_id,
        dst_id,
        src_port,
        dst_port,
        0, //len
        1, //type
        op, //op
        0,
        1024 << 6,
        0
    ], with_header, 0);
    console.log("VSock send op", op, src_id, dst_id, src_port, dst_port);
    console.log(with_header);
    this.transmit(with_header);
};

VirtioVSock.prototype.send = function (src_id, dst_id, src_port, dst_port, data) {
    const with_header = new Uint8Array(44 + data.byteLength);
    const view = new DataView(with_header.buffer, with_header.byteOffset, with_header.byteLength);
    with_header.set(data, 44);

    marshall.Marshall(["d", "d", "w", "w", "w", "h", "h", "w", "w", "w"], [
        src_id,
        dst_id,
        src_port,
        dst_port,
        data.byteLength,
        1,
        5,
        0,
        1024 << 6,
        0
    ], with_header, 0);
    this.transmit(with_header);
};

VirtioVSock.prototype.transmit = function (data)
{
    const queue = this.virtio.queues[0];
    if(queue.has_request()) {
        const bufchain = queue.pop_request();
        bufchain.set_next_blob(data);
        this.virtio.queues[0].push_reply(bufchain);
        this.virtio.queues[0].flush_replies();
    } else {
        console.log("No buffer to write into!");
    }
};

VirtioVSock.prototype.Reset = function() {

};
