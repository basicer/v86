import { LOG_9P } from "../src/const.js";
import { S_IFREG, S_IFDIR, S_IFLNK } from "./filesystem.js";
import * as marshall from "./marshall.js";
import { dbg_log, dbg_assert, dbg_assert_failed } from "../src/log.js";
import { h } from "../src/lib.js";

// For Types Only
import { CPU } from "../src/cpu.js";

import {
    EPERM,
    ENOENT,
    EINVAL,
    EOPNOTSUPP,
    ENOTEMPTY,
    EPROTO,
    EROFS,

    P9_SETATTR_MODE,
    P9_SETATTR_UID,
    P9_SETATTR_GID,
    P9_SETATTR_SIZE,
    P9_SETATTR_ATIME,
    P9_SETATTR_MTIME,
    P9_SETATTR_CTIME,
    P9_SETATTR_ATIME_SET,
    P9_SETATTR_MTIME_SET,

    Virtio9pHandler,
    ENOTDIR,
} from "./9p.js";


/* 9p2000.L open flags (from linux kernel) */
export const P9_DOTL_RDONLY =       0o00000000;
export const P9_DOTL_WRONLY =       0o00000001;
export const P9_DOTL_RDWR =         0o00000002;
export const P9_DOTL_NOACCESS =     0o00000003;
export const P9_DOTL_CREATE =       0o00000100;
export const P9_DOTL_EXCL =         0o00000200;
export const P9_DOTL_NOCTTY =       0o00000400;
export const P9_DOTL_TRUNC =        0o00001000;
export const P9_DOTL_APPEND =       0o00002000;
export const P9_DOTL_NONBLOCK =     0o00004000;
export const P9_DOTL_DSYNC =        0o00010000;
export const P9_DOTL_FASYNC =       0o00020000;
export const P9_DOTL_DIRECT =       0o00040000;
export const P9_DOTL_LARGEFILE =    0o00100000;
export const P9_DOTL_DIRECTORY =    0o00200000;
export const P9_DOTL_NOFOLLOW =     0o00400000;
export const P9_DOTL_NOATIME =      0o01000000;
export const P9_DOTL_CLOEXEC =      0o02000000;
export const P9_DOTL_SYNC =         0o04000000;

const MAX_REPLYBUFFER_SIZE = 16 * 1024 * 1024;

const FID_NONE = -1;
const FID_INODE = 1;
const FID_XATTR = 2;


/**
 * @struct
 * @constructor
 */
function StatLike() {
    this.mode = 0;
    this.uid = 0;
    this.gid = 0;
    this.size = 0;
    this.blksize = 0;
    this.blocks = 0;
    this.major = 0;
    this.minor = 0;
    this.nlinks = 0;
    this.atime = new Date(0);
    this.mtime = new Date(0);
    this.ctime = new Date(0);
    this.ino = 0;
    this.type = 0;
}
StatLike.prototype.isDirectory = function() {};

/**
 * @struct
 * @constructor
*/
function StatFSLike() {
    this.type = 0;
    this.bsize = 0;
    this.blocks = 0;
    this.bfree = 0;
    this.bavail = 0;
    this.files = 0;
    this.ffree = 0;
}

class FileHandleLike {
    /** @returns {Promise<{bytesRead: number}>} */
    async read(buffer, offset, length, position) {}

    /** @returns {Promise<{bytesWritten: number}>} */
    async write(buffer, options, length, position) {}
}

class FSPromisesLike {
    /** @returns {Promise<FileHandleLike>} */
    async open(path, flags, mode) {}

    /** @returns {Promise<StatFSLike>} */
    async statfs(path) {}

    /** @returns {Promise<StatLike>} */
    async lstat(path) {}

    async mkdir(path, mode) {}
    async link(existingPath, newPath) {}
    async symlink(target, path) {}
    async rename(oldPath, newPath) {}
    async unlink(path) {}
    async truncate(path, len) {}
    async rmdir(path) {}
    async chown(path, uid, gid) {}
    async chmod(path, mode) {}
    async readlink(path) {}
    async opendir(path) {}
}

/**
 * @class VirtioNodeFSHandler
 * @extends {Virtio9pHandler}
 * @property {FSPromisesLike} fs
 */
export class VirtioNodeFSHandler extends Virtio9pHandler {

    /**
     * @param {FSPromisesLike|{fs: FSPromisesLike, root: string?}} fs
     * @param {CPU} cpu
     */
    constructor(fs, cpu) {
        super((request, response) => {
            this.process(request).then((data) => {
                response(data);
            });
        }, cpu);

        this.cpu = cpu;
        this.msize = 8192;
        this.replybuffer = new Uint8Array(this.msize*2);
        this.VERSION = "9P2000.L";
        this.fids = {};
        this.fs = fs.fs || fs;
        this.root = fs.root || "";
    }


    Respond(id, tag, format, ...args) {
        // TODO : Dangerous becasue of out of order replies ??
        let replybuffer = this.replybuffer;
        let payloadsize = marshall.Marshall(format.split(""), args, replybuffer, 7);

        dbg_assert(payloadsize >= 0, "9P: Negative payload size");
        marshall.Marshall(["w", "b", "h"], [payloadsize+7, id+1, tag], replybuffer, 0);
        if((payloadsize+7) >= replybuffer.length) {
            dbg_log("Error in 9p: payloadsize exceeds maximum length", LOG_9P);
        }

        return replybuffer.subarray(0, payloadsize + 7);
    }

    RespondError(tag, msg, code) {
        return this.Respond(6, tag, "w", code);
    }

    FIDPath(fid) {
        return this.root + "/"  + this.fids[fid].path.join("/");
    }

    FIDPathPlusFile(fid, file) {
        return this.root + "/"  + this.fids[fid].path.join("/") + "/" + file;
    }

    TrnaslateErrorAndRespond(e, id, tag) {
        let error_message = "";
        let ret = e["errno"];
        if(ret === ENOENT) error_message = "No such file or directory";
        else if(ret === EPERM) error_message = "Operation not permitted";
        else if(ret === ENOTEMPTY) error_message = "Directory not empty";
        else if(ret === EROFS) error_message = "Can not modify read-only file system";
        else if(ret === ENOTDIR) error_message = "Invalid argument";
        else
        {
            error_message = "Unknown error: " + ret;
            console.error(e);
            dbg_assert(false, "[renameat]: Unexpected error code: " + ret);
        }

        return this.RespondError(tag, error_message, ret);
    }

    get_state() {
        let state = super.get_state();

        // TODO: Do this better
        state[8] = [];
        for(let fid in this.fids) {
            let f = this.fids[fid];
            state[8][fid] = [0, fid.type, f.uid, f.path.join("/")];
        }
        return state;
    }

    set_state(state) {
        super.set_state(state);

        if(!(this.tag_bufchain instanceof Map)) {
            this.tag_bufchain = new Map();
        }

        // Recover state from Virtio9p
        if(Array.isArray(state[8])) {
            for(let i = 0; i < state[8].length; i++) {
                let [ino, type, uid, dbgname] = state[8][i];
                this.fids[i] = {type: type, uid: uid, path: dbgname.split("/")};
            }
        }
    }

    async process(buffer) {
        const state = { offset : 0 };
        let [size, id, tag] = marshall.Unmarshall(["w", "b", "h"], buffer, state);

        switch(id)
        {
            case 8: // statfs
            {
                /** @type {StatFSLike} */
                let stat = await this.fs.statfs(this.root + "/");
                dbg_log("[statfs]", LOG_9P);
                return this.Respond(id, tag, "wwddddddw",
                    stat.type,
                    stat.bsize, // optimal transfer block size
                    stat.blocks, // total blocks
                    stat.bfree, // free blocks in fs
                    stat.bavail, // free blocks avail to non-superuser
                    stat.files,
                    stat.ffree,
                    0,
                    256 // maximum length of filenames
                );
            }

            case 112: // topen
            case 12: // tlopen
            {
                let [fid, mode] = marshall.Unmarshall(["w", "w"], buffer, state);
                if(id === 12) dbg_log("[lopen] fid=" + fid + ", mode=" + mode.toString(8), LOG_9P);
                if(id === 112) dbg_log("[open] fid=" + fid + ", mode=" + mode, LOG_9P);


                let stat = await this.fs.lstat(this.FIDPath(fid));
                if(stat.isDirectory()) {
                    this.fids[fid].dirhandle = await this.fs.opendir(this.FIDPath(fid));
                    this.fids[fid].lastoffset = 0;
                } else {
                    let flags;
                    let append = (mode & P9_DOTL_APPEND) !== 0;
                    let trunc = (mode & P9_DOTL_TRUNC) !== 0;
                    let create = (mode & P9_DOTL_CREATE) !== 0;

                    // TODO: Handle create?
                    if(append) {
                        flags = ["r", "a", "a+"][mode & 3];
                    } else {
                        flags = ["r", "w", "w+"][mode & 3];
                    }

                    dbg_log("[open]: flags=" + flags + " append=" + append + " trunc=" + trunc + " create=" + create, LOG_9P);
                    this.fids[fid].fhandle = await this.fs.open(this.FIDPath(fid), flags, mode);
                }

                // TODO: Check iounit
                return this.Respond(id, tag, "Qw", {type: 0, version: 0, path: stat.ino}, this.msize - 24);
            }

            case 70: // link
            {
                var [dfid, fid, name] = marshall.Unmarshall(["w", "w", "s"], buffer, state);
                dbg_log("[link] dfid=" + dfid + ", name=" + name, LOG_9P);

                let dpath = this.FIDPathPlusFile(dfid, name);
                let spath = this.FIDPath(fid);

                try {
                    await this.fs.link(spath, dpath);
                    await this.fs.lchown(dpath, this.fids[dfid].uid);
                } catch(e) {
                    return this.TrnaslateErrorAndRespond(e, id, tag);
                }

                return this.Respond(id, tag, "");
            }

            case 16: // symlink
            {
                var [fid, name, target, gid] = marshall.Unmarshall(["w", "s", "s", "w"], buffer, state);
                dbg_log("[symlink] fid=" + fid + ", name=" + name + ", symgt=" + target + ", gid=" + gid, LOG_9P);

                let path = this.FIDPathPlusFile(fid, name);
                try {
                    await this.fs.symlink(target, path);
                    await this.fs.lchown(path, this.fids[fid].uid, gid);
                } catch(e) {
                    return this.TrnaslateErrorAndRespond(e, id, tag);
                }

                let stat = await this.fs.lstat(path);
                return this.Respond(id, tag, "Q", {type: S_IFLNK, version: 0, path: stat.ino});
            }

            case 18: // mknod
            {
                var [fid, name, mode, major, minor, gid] = marshall.Unmarshall(["w", "s", "w", "w", "w", "w"], buffer, state);
                dbg_log("[mknod] fid=" + fid + ", name=" + name + ", major=" + major + ", minor=" + minor+ "", LOG_9P);
                return this.RespondError(tag, "Mknod not supported", EOPNOTSUPP);
                /*
                var idx = this.fs.CreateNode(name, this.fids[fid].inodeid, major, minor);
                var inode = this.fs.GetInode(idx);
                inode.mode = mode;
                //inode.mode = mode | S_IFCHR; // XXX: fails "Mknod - fifo" test
                inode.uid = this.fids[fid].uid;
                inode.gid = gid;

                marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
                this.BuildReply(id, tag, 13);
                SendReply();
                break;
                */
            }


            case 22: // TREADLINK
            {
                var [fid] = marshall.Unmarshall(["w"], buffer, state);
                let path = this.FIDPath(fid);
                dbg_log("[readlink] fid=" + fid + " name=" + path, LOG_9P);
                let target = await this.fs.readlink(path);
                return this.Respond(id, tag, "s", target);
            }


            case 72: // tmkdir
            {
                var [fid, name, mode, gid] = marshall.Unmarshall(["w", "s", "w", "w"], buffer, state);
                dbg_log("[mkdir] fid=" + fid + ", name=" + name + ", mode=" + mode + ", gid=" + gid, LOG_9P);

                let path = this.FIDPathPlusFile(fid, name);
                await this.fs.mkdir(path, mode);
                await this.fs.lchown(path, this.fids[fid].uid, gid);
                let stat = await this.fs.lstat(path);

                return this.Respond(id, tag, "Q", {type: S_IFDIR, version: 0, path: stat.ino});
            }

            case 14: // tlcreate
            {
                var [fid, name, flags, mode, gid] = marshall.Unmarshall(["w", "s", "w", "w", "w"], buffer, state);
                let path = this.FIDPathPlusFile(fid, name);

                dbg_log("[create] fid=" + fid + ", name=" + name + ", flags=" + flags + ", mode=" + mode + ", gid=" + gid, LOG_9P);

                /*
                var idx = this.fs.CreateFile(name, this.fids[fid].inodeid);
                this.fids[fid].inodeid = idx;
                this.fids[fid].type = FID_INODE;
                this.fids[fid].dbg_name = name;
                var inode = this.fs.GetInode(idx);
                inode.uid = this.fids[fid].uid;
                inode.gid = gid;
                inode.mode = mode | S_IFREG;
                */
                let f = this.fids[fid];
                try {
                    f.fhandle = await this.fs.open(path, "w+", mode);
                    await f.fhandle.chown(f.uid, gid);
                } catch(e) {
                    return this.TrnaslateErrorAndRespond(e, id, tag);
                }

                let stat;
                try {
                    stat = await this.fs.lstat(path);
                } catch(e) {
                    return this.TrnaslateErrorAndRespond(e, id, tag);
                }
                this.cpu.bus.send("9p-create", [name, stat.ino]);
                return this.Respond(id, tag, "Qw", {type: S_IFREG, version: 0, path: stat.ino}, this.msize - 24);
            }

            case 52: // lock
            {
                var [fid, n, flags, m, lock_length] = marshall.Unmarshall(["w", "b", "w", "d", "d", "w", "s"], buffer, state);
                lock_length = lock_length === 0 ? Infinity : lock_length;

                /*
                var lock_request = this.fs.DescribeLock(req[1], req[3], lock_length, req[5], req[6]);
                dbg_log("[lock] fid=" + fid +
                    ", type=" + P9_LOCK_TYPES[lock_request.type] + ", start=" + lock_request.start +
                    ", length=" + lock_request.length + ", proc_id=" + lock_request.proc_id);

                var ret = this.fs.Lock(this.fids[fid].inodeid, lock_request, flags);

                marshall.Marshall(["b"], [ret], this.replybuffer, 7);
                this.BuildReply(id, tag, 1);
                SendReply();
                break;
                */
                return this.RespondError(tag, "Lock not supported", EOPNOTSUPP);
            }

            case 54: // getlock
            {
                var req = marshall.Unmarshall(["w", "b", "d", "d", "w", "s"], buffer, state);
                /*
                var fid = req[0];
                var lock_length = req[3] === 0 ? Infinity : req[3];
                var lock_request = this.fs.DescribeLock(req[1], req[2], lock_length, req[4], req[5]);
                dbg_log("[getlock] fid=" + fid +
                    ", type=" + P9_LOCK_TYPES[lock_request.type] + ", start=" + lock_request.start +
                    ", length=" + lock_request.length + ", proc_id=" + lock_request.proc_id);

                var ret = this.fs.GetLock(this.fids[fid].inodeid, lock_request);

                if(!ret)
                {
                    ret = lock_request;
                    ret.type = P9_LOCK_TYPE_UNLCK;
                }

                var ret_length = ret.length === Infinity ? 0 : ret.length;

                size = marshall.Marshall(["b", "d", "d", "w", "s"],
                    [ret.type, ret.start, ret_length, ret.proc_id, ret.client_id],
                    this.replybuffer, 7);

                this.BuildReply(id, tag, size);
                SendReply();
                break;
                */
                return this.RespondError(tag, "GetLock not supported", EOPNOTSUPP);
            }

            case 24: // getattr
            {
                var [fid, mask] = marshall.Unmarshall(["w", "d"], buffer, state);
                dbg_log("[getattr]: fid=" + fid + " request mask=" + mask, LOG_9P);

                /** @type {StatLike} */
                let stat;

                try {
                    stat = await this.fs.lstat(this.FIDPath(fid));
                } catch(e) {
                    return this.TrnaslateErrorAndRespond(e, id, tag);
                }


                return this.Respond(id, tag,"dQwwwddddddddddddddd",
                    mask,
                    {type: 0, version: 0, path: stat.ino},

                    stat.mode, // TODO: Normalize;
                    stat.uid,
                    stat.gid,

                    stat.nlinks, // number of hard links
                    (stat.major<<8) | (stat.minor), // device id low
                    stat.size,
                    stat.blksize,
                    stat.blocks,
                    Math.floor(stat.atime.getTime() / 1000), // atime
                    0x0,
                    Math.floor(stat.mtime.getTime() / 1000), // mtime
                    0x0,
                    Math.floor(stat.ctime.getTime() / 1000), // ctime
                    0x0,
                    0x0, // btime
                    0x0,
                    0x0, // st_gen
                    0x0, // data_version
                );
            }

            case 26: // setattr
            {
                let [fid, mask, mode, uid, gid, fsize, atime, atimems, mtime, mitmems] = marshall.Unmarshall(["w", "w",
                    "w", // mode
                    "w", "w", // uid, gid
                    "d", // size
                    "d", "d", // atime
                    "d", "d", // mtime
                ], buffer, state);

                let path = this.FIDPath(fid);

                dbg_log("[setattr]: fid=" + fid + " request mask=" + mask + " name=" + path, LOG_9P);
                if(mask & P9_SETATTR_MODE) {
                    await this.fs.chmod(path, mode);
                }
                if(mask & P9_SETATTR_UID) {
                    await this.fs.chown(path, uid, -1);
                }
                if(mask & P9_SETATTR_GID) {
                    await this.fs.chown(path, -1, gid);
                }

                // TODO: atime, mtime
                /*
                if(mask & P9_SETATTR_ATIME) {
                    node.atime = Math.floor((new Date()).getTime()/1000);
                }
                if(mask & P9_SETATTR_MTIME) {
                    inode.mtime = Math.floor((new Date()).getTime()/1000);
                }
                if(mask & P9_SETATTR_CTIME) {
                    inode.ctime = Math.floor((new Date()).getTime()/1000);
                }
                if(mask & P9_SETATTR_ATIME_SET) {
                    inode.atime = req[6];
                }
                if(mask & P9_SETATTR_MTIME_SET) {
                    inode.mtime = req[8];
                }
                */
                if(mask & P9_SETATTR_SIZE) {
                    await this.fs.truncate(path, fsize);
                }

                return this.Respond(id, tag, "");
            }

            case 50: // fsync
            {
                var [fid, datasync] = marshall.Unmarshall(["w", "d"], buffer, state);
                dbg_log("[fsync]: fid=" + fid + " datasync=" + datasync, LOG_9P);

                let f = this.fids[fid];

                // TODO: Error Handling
                if(f.fhandle) await f.fhandle.sync();

                return this.Respond(id, tag, 0);
            }

            case 40: // TREADDIR
            case 116: // read
            {
                let [fid, offset, count] = marshall.Unmarshall(["w", "d", "w"], buffer, state);
                // var inode = this.fs.GetInode(this.fids[fid].inodeid);
                if(id === 40) dbg_log("[treaddir]: fid=" + fid + " offset=" + offset + " count=" + count, LOG_9P);
                if(id === 116) dbg_log("[read]: fid=" + fid + " (" + this.FIDPath(fid) + ") offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type, LOG_9P);

                /*
                if(!inode || inode.status === STATUS_UNLINKED)
                {
                    dbg_log("read/treaddir: unlinked", LOG_9P);
                    return this.RespondError(tag, "No such file or directory", ENOENT);
                }
                    */
                if(this.fids[fid].type === FID_XATTR) {
                    /*
                    if(inode.caps.length < offset+count) count = inode.caps.length - offset;
                    for(var i=0; i<count; i++)
                        this.replybuffer[7+4+i] = inode.caps[offset+i];
                    marshall.Marshall(["w"], [count], this.replybuffer, 7);
                    this.BuildReply(id, tag, 4 + count);
                    SendReply();
                    return
                    */
                    return this.RespondError(tag, "Xattr not supported", EOPNOTSUPP);
                }

                count = Math.min(count, this.replybuffer.length - (7 + 4));

                let f = this.fids[fid];

                if(f.dirhandle && id === 40) {

                    // TODO: Allow reading in chunks
                    if(offset !== f.lastoffset) {
                        dbg_assert_failed("treaddir: non-sequential reads not supported: got: " + offset + ", expected: " + f.lastoffset);
                    }

                    let ents = [];
                    while(true) {
                        let dirent = await f.dirhandle.read();
                        if(!dirent) break;
                        ents.push(dirent);
                        // if (--max <= 0) break;
                    }
                    let dirbuf = new Uint8Array(ents.length * 500); // TODO: Size?
                    let foffset = offset;
                    let woffset = 0;

                    for(let e of ents) {
                        ++foffset;
                        let type = e.type; // TODO: Normalize
                        let qid = {type: 0, version: 0, path: e.ino};
                        woffset += marshall.Marshall(["Q", "d", "b", "s"], [qid, foffset, type, e.name], dirbuf, woffset);
                    }
                    f.lastoffset = foffset; // TODO: Something else ?

                    return this.Respond(id, tag, "w-", woffset, dirbuf.subarray(0, woffset));
                }

                let path = this.FIDPath(fid);
                this.cpu.bus.send("9p-read-start", [path]);

                let buf = new Uint8Array(count);
                dbg_log("[read]: Reading " + count + " bytes at offset " + offset + " of " + buf.byteLength, LOG_9P);

                // TODO: Error Handling, also check offset
                let res = await f.fhandle.read(buf, 0, buf.byteLength, offset);

                dbg_log("[read]: Read " + res.bytesRead + " bytes", LOG_9P);
                this.cpu.bus.send("9p-read-end", [path, res.bytesRead]);

                return this.Respond(id, tag, "w-", res.bytesRead, buf.subarray(0, res.bytesRead));
            }

            case 118: // write
            {
                var [fid, offset, count] = marshall.Unmarshall(["w", "d", "w"], buffer, state);

                const path = this.FIDPath(fid);
                let f = this.fids[fid];
                dbg_log("[write]: fid=" + fid + " (" + path + ") offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type, LOG_9P);
                let wrote;
                if(this.fids[fid].type === FID_XATTR)
                {
                    // XXX: xattr not supported yet. Ignore write.
                    return this.RespondError(tag, "Setxattr not supported", EOPNOTSUPP);
                }
                else
                {
                    let data = buffer.subarray(state.offset);
                    wrote = await f.fhandle.write(data, {}, data.byteLength, offset);
                }

                this.cpu.bus.send("9p-write-end", [path, wrote.bytesWritten]);
                return this.Respond(id, tag, "w", wrote.bytesWritten);
            }

            case 74: // RENAMEAT
            {
                let [olddirfid, oldname, newdirfid, newname] = marshall.Unmarshall(["w", "s", "w", "s"], buffer, state);
                dbg_log("[renameat]: oldname=" + oldname + " newname=" + newname, LOG_9P);

                let oldpath = this.FIDPathPlusFile(olddirfid, oldname);
                let newpath = this.FIDPathPlusFile(newdirfid, newname);

                try {
                    await this.fs.rename(oldpath, newpath);
                } catch(e) {
                    return this.TrnaslateErrorAndRespond(e, id, tag);
                }
                // TODO: Update other FID paths?
                return this.Respond(id, tag, "");
            }

            case 76: // TUNLINKAT
            {
                var [dirfd, name, flags] = marshall.Unmarshall(["w", "s", "w"], buffer, state);
                dbg_log("[unlink]: dirfd=" + dirfd + " name=" + name + " flags=" + flags, LOG_9P);

                let path = this.FIDPathPlusFile(dirfd, name);

                /*
                if(fid === -1) {
                    this.SendError(tag, "No such file or directory", ENOENT);
                    SendReply();
                    break;
                }
                */

                try {
                    let stat = await this.fs.lstat(path);
                    if(stat.isDirectory()) {
                        await this.fs.rmdir(path);
                    } else {
                        await this.fs.unlink(path);
                    }
                } catch(e) {
                    return this.TrnaslateErrorAndRespond(e, id, tag);
                }
                return this.Respond(id, tag, "");
            }

            case 100: // version
            {
                let [msize, version] = marshall.Unmarshall(["w", "s"], buffer, state);
                dbg_log("[version]: msize=" + msize + " version=" + version, LOG_9P);

                if(this.msize !== msize)
                {
                    this.msize = msize;
                    this.replybuffer = new Uint8Array(Math.min(MAX_REPLYBUFFER_SIZE, this.msize*2));
                }
                return this.Respond(id, tag, "ws", this.msize, this.VERSION);
            }

            case 104: // attach
            {
                // return root directorie's QID
                var [fid, afid, uname, aname, uid] = marshall.Unmarshall(["w", "w", "s", "s", "w"], buffer, state);
                dbg_log("[attach]: fid=" + fid + " afid=" + h(afid) + " uname=" + uname + " aname=" + aname + " uid=" + uid, LOG_9P);

                let stat;
                try {
                    stat = await this.fs.lstat(this.root + "/");
                } catch(e) {
                    dbg_log("Attach: root not found: " + e, LOG_9P);
                    return this.TrnaslateErrorAndRespond(e, id, tag);
                }

                let inode_qid = {type: 0, version: 0, path: stat.ino};
                this.fids[fid] = {type: FID_INODE, ino: stat.ino, uid: uid, path: []};
                this.cpu.bus.send("9p-attach");
                return this.Respond(id, tag, "Q", inode_qid);
            }

            case 108: // tflush
            {
                var [oldtag] = marshall.Unmarshall(["h"], buffer, state);
                dbg_log("[flush] " + tag + " oldtag=" + oldtag, LOG_9P);
                //marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
                return this.Respond(id, tag, "");
            }

            case 110: // walk
            {
                var [fid, nwfid, nwname] = marshall.Unmarshall(["w", "w", "h"], buffer, state);
                dbg_log("[walk]: fid=" + fid + " nwfid=" + nwfid + " nwname=" + nwname, LOG_9P);
                if(nwname === 0) {
                    // TODO: Check FID Not open
                    this.fids[nwfid] = {...this.fids[fid]};
                    return this.Respond(id, tag, "h", 0);
                }
                var wnames = [];
                for(var i=0; i<nwname; i++) {
                    wnames.push("s");
                }
                var walk = marshall.Unmarshall(wnames, buffer, state);
                var offset = 0;
                var nwidx = 0;
                //console.log(idx, this.fs.GetInode(idx));
                dbg_log("walk in dir " + this.FIDPath(fid) + " to: " + walk.toString(), LOG_9P);
                let qids = new Uint8Array(nwname * 13);
                let path = this.FIDPath(fid);
                let patha = [...this.fids[fid].path];
                for(var i=0; i<nwname; i++) {
                    // TODO: Check for ., ..
                    path += "/" + walk[i];
                    patha.push(walk[i]);
                    let stat;
                    try {
                        stat = await this.fs.lstat(path);
                    } catch(e) {
                        dbg_log("Could not find: " + walk[i], LOG_9P);
                        break;
                    }

                    offset += marshall.Marshall(["Q"], [{type: 0, version: 0, path: stat.ino}], qids, offset);
                    nwidx++;
                    this.fids[nwfid] = {type: FID_INODE, ino: stat.ino, uid: this.fids[fid].uid, path: patha};
                }

                return this.Respond(id, tag, "h-", nwidx, qids.subarray(0, offset));
            }

            case 120: // clunk
            {
                var [fid] = marshall.Unmarshall(["w"], buffer, state);
                dbg_log("[clunk]: fid=" + fid, LOG_9P);
                if(this.fids[fid]) {
                    if(this.fids[fid].dirhandle) {
                        this.fids[fid].dirhandle.close();
                    }
                    if(this.fids[fid].fhandle) {
                        this.fids[fid].fhandle.close();
                    }
                    delete this.fids[fid];
                }
                return this.Respond(id, tag, "");
            }

            case 32: // txattrcreate
            {
                var [fid, name, attr_size, flags] = marshall.Unmarshall(["w", "s", "d", "w"], buffer, state);
                dbg_log("[txattrcreate]: fid=" + fid + " name=" + name + " attr_size=" + attr_size + " flags=" + flags, LOG_9P);

                // XXX: xattr not supported yet. E.g. checks corresponding to the flags needed.
                this.fids[fid].type = FID_XATTR;

                return this.Respond(id, tag, "");
            }

            case 30: // xattrwalk
            {
                var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
                var fid = req[0];
                var newfid = req[1];
                var name = req[2];
                dbg_log("[xattrwalk]: fid=" + req[0] + " newfid=" + req[1] + " name=" + req[2], LOG_9P);

                return this.RespondError(tag, "Setxattr not supported", EOPNOTSUPP);

                /*
                // Workaround for Linux restarts writes until full blocksize
                this.fids[newfid] = this.Createfid(this.fids[fid].inodeid, FID_NONE, this.fids[fid].uid, this.fids[fid].dbg_name);
                //this.fids[newfid].inodeid = this.fids[fid].inodeid;
                //this.fids[newfid].type = FID_NONE;
                var length = 0;
                if (name === "security.capability") {
                    length = this.fs.PrepareCAPs(this.fids[fid].inodeid);
                    this.fids[newfid].type = FID_XATTR;
                }
                marshall.Marshall(["d"], [length], this.replybuffer, 7);
                this.BuildReply(id, tag, 8);
                SendReply();
                */
            }

            default:
                dbg_log("Error in Virtio9p: Unknown id " + id + " received", LOG_9P);
                dbg_assert(false);
                //this.SendError(tag, "Operation i not supported",  EOPNOTSUPP);
                //SendReply();
                break;
        }

        //consistency checks if there are problems with the filesystem
        //this.fs.Check();
    }
}
