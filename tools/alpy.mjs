
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

let NodeFetchCache;
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

try {
    let cache_path = path.join(__dirname, "cache");
    let module = await import('node-fetch-cache');
    NodeFetchCache = module.default;
    if (!fs.existsSync(cache_path)) {
        fs.mkdirSync(cache_path);
    }
    globalThis.fetch = NodeFetchCache.create({
        shouldCacheResponse: (response) => response.ok && /proxy.alpine.sh/.test(response.url),
        cache: new module.FileSystemCache({
            cacheDirectory: cache_path
        }),
    })
    
} catch ( e ) {
    console.warn("Install 'node-fetch-cache' to cache output: ", e);
}





let files = [
    "src/const.js",
    "src/config.js",
    "src/cpu.js",
    "src/io.js",
    "src/main.js",
    "src/lib.js",
    "src/buffer.js",
    "src/ide.js",
    "src/pci.js",
    "src/floppy.js",
    "src/memory.js",
    "src/dma.js",
    "src/pit.js",
    "src/vga.js",
    "src/ps2.js",
    
    "src/rtc.js",
    "src/uart.js",
    
    "src/acpi.js",
    "src/apic.js",
    "src/ioapic.js",

    "src/state.js",
    "src/ne2k.js",
    "src/sb16.js",
    "src/virtio.js",
    "src/virtio_console.js",
    "src/bus.js",
    "src/log.js",
    
    "src/debug.js",
    "src/elf.js",
    "src/kernel.js",

    "lib/9p.js",
    "lib/filesystem.js",
    "lib/jor1k.js",
    "lib/marshall.js",
    "lib/utf8.js",

    "src/browser/screen.js",
    "src/browser/keyboard.js",
    "src/browser/mouse.js",
    "src/browser/speaker.js",
    "src/browser/serial.js",
    "src/browser/network.js",
    "src/browser/fetch_network.js",
    "src/browser/starter.js",
    "src/browser/worker_bus.js",
    "src/browser/dummy_screen.js",
    "src/browser/print_stats.js",
    "src/browser/filestorage.js"
];

let cloud_config = `#alpine-config

packages:
  - agetty
  - git
  - curl
  - tcpdump
  - sudo

apk:
  repositories:
    - base_url: http://proxy.alpine.sh/alpine-mirror
      repos: ['main', 'community']
      version: edge

bootcmd:
  - |
    echo "alpine.sh" > /etc/hostname
    hostname -F /etc/hostname

runcmd:
  - |
    echo hi

  - |
    echo '%wheel ALL=(ALL) NOPASSWD: ALL' > "/etc/sudoers.d/wheel"

  - |
    sed -i 's/ttyS/#ttyS/' /etc/inittab
    for tty in ttyS0 ttyS1 hvc0; do
        ln -s agetty /etc/init.d/agetty.$tty
        echo 'term_type="xterm-256color"' > /etc/conf.d/agetty.$tty
        echo 'agetty_options="-w --autologin alpine"' >> /etc/conf.d/agetty.$tty
        rc-update add agetty.$tty default
        rc-service agetty.$tty start
    done
    init -q

`;

globalThis.require = (what) => {
    return ({
        crypto,
        fs
    })[what]
};
let v86 = {};
globalThis.module = {exports:v86};

for ( let f of files ) {
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "..", "v86", f), 'utf8'), {
        filename: f
    });
}

globalThis.DEBUG = false;
globalThis.LOG_LEVEL = globalThis.LOG_NET;

let opts = {
    wasm_path: path.join(__dirname, "..", "build", "v86.wasm"),
    memory_size: 1024 * 1024 * 1024,
    uart0: true,
    virtio_console: true,
    cmdline: [
        "console=ttyS0",
        "ip=dhcp",
        "ds=nocloud;s=http://selfconfig.local/config",
        "alpine_repo=http://proxy.alpine.sh/alpine-mirror/edge/main",
        "pkgs=agetty"
    ].join(" "),
    autostart: true,
    network_relay_url: 'fetch',
    filesystem: {
    //    //basefs: path.join(__dirname, "fs.json"),
    //    baseurl: "https://alpine-v86-fs.alpine.sh/base/",
    },
    //initial_state: { url:  path.join(__dirname, "state.zst") },
};

let makeLoadable = (url) => {
    let o = {
        get: () => console.log('GET'),
        set: () => console.log('SET'),
        load: async () => {
            let req = await fetch(url);
            let ab = await req.arrayBuffer();
            o.buffer = ab;
            o.onload(new Uint8Array(ab.buffer));
        }
    };
    return o;
}

let bzimage = makeLoadable('https://proxy.alpine.sh/alpine-mirror/latest-stable/releases/x86/netboot/vmlinuz-lts');
let initrd = makeLoadable('https://proxy.alpine.sh/alpine-mirror/latest-stable/releases/x86/netboot/initramfs-lts');

if (process.argv[2]) {
    console.log(process.argv[2]);
    opts = {
        preserve_mac_from_state_image: true,
        initial_state: { url:  process.argv[2] },
        ...opts
    }
} else {
    opts = {
        bios: { url: path.join(__dirname, "..", "bios", "seabios.bin") },
        bzimage: bzimage,
        initrd: initrd,
        ...opts
    }
}

var emulator = new v86.V86(opts);

emulator.add_listener("9p-attach", async function () {
    await emulator.fs9p.CreateTextFile("hi", "hi!");
});

// mkdir /mnt && mount -t 9p -o trans=virtio host9p /mnt -oversion=9p2000.L

emulator.add_listener("emulator-ready", async function () {
    console.log("Ready");
    let network_adapter = emulator.network_adapter;
    let original_fetch = network_adapter.fetch;

    network_adapter.fetch = (url, opts) => {
        if (url == "http://selfconfig.local/config/user-data") {
            let contents = new TextEncoder().encode(cloud_config);
            let headers = new Headers();
            return new Promise(res => setTimeout(() => res([
                {status: 200, statusText: "OK", headers: headers},
                contents.buffer
            ]), 50));
        } else if ( /^http:\/\/selfconfig.local/.test(url) ) {
            let contents = new TextEncoder().encode('Not Found');
            let headers = new Headers();
            return new Promise(res => setTimeout(() => res([
                {status: 404, statusText: "Not Found", headers: headers},
                contents.buffer
            ]), 50));
        }
        return original_fetch(url, opts);
    }

    emulator.fs9p.storage.load_from_server = async (what) => {
        let res = await fetch(what);
        const arr = new Uint8Array(await res.arrayBuffer());
        await emulator.fs9p.storage.cache(what, arr);
        return arr;
    }
});


emulator.add_listener("download-progress", function (e) {
  console.log(
    "\rLoading " +
      e.file_name +
      ": " +
      Math.floor((100 * e.loaded) / e.total) +
      "%           ",
  );
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");


emulator.add_listener("serial1-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    process.stdout.write(chr);
});

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    process.stdout.write(chr);
});

emulator.add_listener("virtio-console0-output-bytes", function(bytes)
{
    process.stdout.write(new TextDecoder().decode(bytes));
});
emulator.add_listener("virtio-console1-output-bytes", function(bytes)
{
    process.stdout.write("1[")
    process.stdout.write(new TextDecoder().decode(bytes));
    process.stdout.write("]")
});
emulator.add_listener("virtio-console2-output-bytes", function(bytes)
{
    process.stdout.write("2[")
    process.stdout.write(new TextDecoder().decode(bytes));
    process.stdout.write("]")
});

emulator.add_listener("virtio-console3-output-bytes", function(bytes)
{
    process.stdout.write("3[")
    process.stdout.write(new TextDecoder().decode(bytes));
    process.stdout.write("]")
});


process.stdout.on('resize', () => {
    emulator.bus.send(`virtio-console0-resize`, [process.stdout.columns, process.stdout.rows]);
})

var state;
let abort = false;
let abort_timeout;
let io = 'virtio-console0-input-bytes';
process.stdin.on("data", async function(c)
{
    if(c === "\u0003")
    {
        if (!abort) {
            abort = true;
            if (abort_timeout) clearTimeout(abort_timeout);
            abort_timeout = setTimeout(() => {
                abort = false;
                abort_timeout = undefined;
            }, 500)
        } else {
            // ctrl c
            emulator.stop();
            process.stdin.pause();
            return;
        }
    }
    else if(c === "\x1b\x4f\x51")
    {
        // f2
        state = await emulator.save_state();
        fs.writeFileSync("ct-state", Buffer.from(state));
        console.log("--- Saved ---");
        return;
    }
    else if(c === "\x1b\x4f\x52")
    {
        // f3
        if(state)
        {
            console.log("--- Restored ---");
            await emulator.restore_state(fs.readFileSync("ct-state"));
        }
        return;
    }
    else if(c === "\x1b\x4f\x53")
    {
        io = io == 'serial0-input' ? 'virtio-console0-input-bytes' : 'serial0-input';
        console.log("IO", io);
        return;
    }

    if ( io != 'serial0-input') {
        emulator.bus.send(io, new TextEncoder().encode(c));
    } else {
        for(var i = 0; i < c.length; i++)
        {
            emulator.bus.send(`serial0-input`, c.charCodeAt(i));
        }
    } 
});
