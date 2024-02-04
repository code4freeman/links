import { Server } from "node:net";
import { Readable, Writable } from "node:stream";
import { once, on } from "node:events";
import { parseHeader } from "./tool.js";
import fs from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import formDataParser from "./form-data-parser.js";

process.on("uncaughtException", err => {
    if (err.message.includes("ECONNRESET")) return;
    throw err;
}); 

const srv = new Server;
srv.listen("8612");
for await (let [sock] of on(srv, "connection")) Http(sock);

async function Http (sock) {

    let isHandleHeader = true;
    let bytes = Buffer.from([]);
    let request, response;
    let len = 0;
    let length = 0;

    for await (let [chunk] of on(sock, "data")) {

        bytes = Buffer.concat([ bytes, chunk ]);
    
        request?.push();
        handle();

        if (bytes.length > 1024 * 1024 * 100) {
            sock.pause();
        }
    }

    function handle () {
        if (!isHandleHeader) return;

        const [header, headerLen] = parseHeader(bytes);
        if (!header) return;

        isHandleHeader = false;

        length = header["content-length"] || 0;
    
        if (bytes.length > headerLen) {
            bytes = bytes.subarray(headerLen);
        } else {
            bytes = Buffer.from([]);
        }
    
        request = new Readable({
            highWaterMark: 1024 * 1024 * 100,
            read () {
                while (true) {

                    if (len >= length) {
                        this.push(null);
                        len = 0;
                        length = 0;
                        isHandleHeader = true;

                        if (bytes.length) handle();
                        return;
                    }

                    if (!bytes.length < 1024 * 1024 * 100) {
                        sock.resume();
                    }

                    if (!bytes.length) break;

                    const left = length - len;
                    let _bytes;

                    if (left >= bytes.length) {
                        _bytes = bytes;
                        bytes = Buffer.from([]);
                    }
                    if (left < bytes.length) {
                        _bytes = bytes.subarray(0, left);
                        bytes = bytes.subarray(left);
                    }
        
                    len += _bytes.length;

                    if (
                        !this.push(_bytes)
                    ) break;

                }
            },
        });
        request.$header = header; // 懒得封装了，直接挂属性
    
        response = new Writable({
            async write (...[_bytes,, done]) {
                const is = sock.write(_bytes);
                if (!is) await once(sock, "drain");
                done();
            },
        });
    
        if (request.$header.method === "GET" && request.$header.path === "/") {
            routerMain(request, response);
            return;
        }

        if (request.$header.method === "POST" && request.$header.path === "/upload") {
            routerUpload(request, response);
            return;
        }

        response.write("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n404");
    }
}


/**
 * 主路由
 * 
 * @param {*} request 
 * @param {*} response 
 */
function routerMain (request, response) {
    // 测试文件较小，暂不用流
    const htmlBytes = fs.readFileSync("./index.html");
    response.write(`HTTP/1.1 200 OK\r\nContent-Length: ${htmlBytes.length}\r\n\r\n`);
    response.write(htmlBytes);
}

/**
 * 上传文件路由
 * 
 * @param {*} request 
 * @param {*} response 
 */
async function routerUpload (request, response) {

    const { err, fields } = await formDataParser(
        request, 
        {   
            dir: resolvePath(dirname(fileURLToPath(import.meta.url)), "upload"),
        }
    );

    if (err) {
        response.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nerror");
        throw err;
    }

    console.log(fields);
    
    const json = Buffer.from(JSON.stringify(fields));
    const len = json.length;
    response.write(`HTTP/1.1 200 OK\r\nContent-Length: ${len}\r\nContent-Type: application/json\r\n\r\n${json.toString()}`);
}
