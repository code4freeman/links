import { parseKVS, readBoundary } from "./tool.js";
import { Stream } from "node:stream";
import { resolve as resolvePath} from "node:path";
import { createWriteStream } from "node:fs";
import { flag_enum } from "./tool.js";

const ERROR_ENUM = {
    "REQUEST_OBJ_INVALIDE": "request对象不合法，必须是可读流对象！",
    "POST_DATA_INVALIDE":   "post content-type不合法，必须是multipart/form-data!",
    "FORM_DATA_FORMAT_ERROR": "post 数据格式错误，不符合multipart/form-data",
};

const STATES = Object.entries({

    BOUNDARY: 1,
    TYPE_KV: 2,
    DATA: 3,
    MAYBE_END: 4,
    END: 5,

}).reduce((r, [k, v]) => (r[k] = v, r[v] = k, r), Object.create(null));

function Result (err, fields = []) {
    const _ = Object.create(null);
    _.err = err instanceof Error ? err : err ? new Error(err) : err;
    _.fields = fields;
    return Object.freeze(_);
}

/**
 * 本篇日志的核心函数，解析http form-data数据
 * 
 * @param {stream.Readable} request http form-data body部分数据流
 * 
 * @param {{ dir?: string }} [options=undefined] 选项，这里代码演示为主，只提供文件存放地址，因为偷懒且只能传入绝对地址
 *                                               比如其他的文件大小限制、进度事件... 不想搞了
 * 
 * @return {Promise<{ error?: Error, fields?: { [key: string]: string } }>}
 */
export default async function formDataParser (request, { dir }) {

    if (!(request instanceof Stream)) {
        return new Result(ERROR_ENUM.REQUEST_OBJ_INVALIDE);
    }

    let boundary = (
        /.*boundary=(-+\w+).*/i.exec(
            request.$header["content-type"]
        ) ?? []
    )[1];

    if (!boundary) {
        return Result(ERROR_ENUM.POST_DATA_INVALIDE);
    }

    boundary = Buffer.from("\r\n--" + boundary);
    const boundaryLen = boundary.byteLength;

    const dirPath = resolvePath(dir ?? process.pwd());

    let done = () => {};
    const resultPromise = new Promise(r => done = r);    
    const defer = () => {
        request.removeListener("data", onData);
    };

    const boundaryChars = boundary.reduce((r, c) => (r[c] = true, r), Object.create(null));
    const fields = Object.create(null);
    let i = 0;
    let boundaryIndex = -1;
    let state = STATES.BOUNDARY; 
    let bytes = Buffer.alloc(0);
    let currentField = "";
    let currentFilename = "";
    let currentFileStream;
   
    request.on("data", onData);

    return resultPromise;

    async function onData (chunk) {

        bytes = Buffer.concat([ bytes, chunk ]);

        while (true) {

            switch (state) {
                case STATES.BOUNDARY:
                    let bdy;
                    [ bdy, i ] = readBoundary(bytes, boundary.slice(2), i);
                    if (!bdy) {
                        if (bytes.length < boundaryLen) return;
                        else {
                            done(Result(ERROR_ENUM.FORM_DATA_FORMAT_ERROR));
                            defer();
                            return;
                        }
                    } 
                    bytes = bytes.subarray(i);
                    i = 0;
                    state = STATES.TYPE_KV;

                    break;
                case STATES.TYPE_KV:
                    let kv, header;
                    [ kv, i ] = parseKVS(bytes, i);
                    if (!kv.length) {
                        i = 0;
                        return;
                    }

                    bytes = bytes.subarray(i);
                    i = 0;

                    header = kv
                        .map(it => Buffer.from(it).toString("utf8"))
                        .reduce((r, c, i, _) => {
                            if (i % 2) r[_[i - 1]] = c;
                            return r;
                        }, Object.create(null));
                    
                    const cd = header["Content-Disposition"];
                    const fieldName = (/.*(?<!file)name=\"([^\"]+)\"/i.exec(cd) || [])[1];
                    const fileName = (/.*filename=\"([^\"]+)\"/i.exec(cd) || [])[1];

                    fields[fieldName] = fileName ? fileName : Buffer.alloc(0); 
                    currentField = fieldName;

                    if (fileName) {
                        currentFilename = fileName;
                        const filePath = resolvePath(dirPath, fileName);
                        currentFileStream = createWriteStream(filePath, { highWaterMark: 1024 * 1024 * 200 });
                    }

                    state = STATES.DATA;

                    break;
                case STATES.DATA:    
                   
                    if (boundaryIndex > -1) {
                        if (boundaryIndex === boundaryLen) {
                            boundaryIndex = -1;

                            const _bytes = bytes.subarray(0, i - boundaryLen);
                            bytes = bytes.subarray(i);
                            i = 0;

                            if (currentFileStream && currentFilename) {
                                request.pause();
                                await new Promise(r => currentFileStream.write(_bytes, r));
                                request.resume();
                                currentFileStream.end();
                                currentFileStream.close();

                                currentFileStream = null;
                                currentField = "";
                            } else {
                                fields[currentField] = Buffer.concat([ fields[currentField], _bytes ]).toString("utf8");
                                currentField = "";
                                currentFilename = "";
                            }
                            
                            state = STATES.MAYBE_END;
                            break;
                        }
                        if (boundary[boundaryIndex] !== bytes[i]) {
                            i++;
                            boundaryIndex = -1;
                            break;
                        }
                        i++;
                        boundaryIndex++;
                    } else {
                        i += boundaryLen - 1;

                        if (bytes[i] === undefined) {
                            i -= boundaryLen - 1;

                            const _bytes = bytes.subarray(0, i);
                            bytes = bytes.subarray(i);
                            i = 0;

                            if (currentFilename && currentFileStream) {
                                if (!currentFileStream.write(_bytes)) {
                                    request.pause();
                                    await new Promise(r => {
                                        currentFileStream.on("drain", () => {
                                            currentFileStream.removeAllListeners("darin");
                                            r();
                                        });
                                    });
                                    request.resume();
                                }
                            } else {
                                fields[currentField] = Buffer.concat([ fields[currentField], _bytes]);
                            }
                            
                            return;
                        }

                        if (bytes[i] in boundaryChars) {
                            i -= boundaryLen - 1;
                            boundaryIndex = 0;
                        }
                    }

                    break;
                case STATES.MAYBE_END:
                    if ([ bytes[i], bytes[i + 1] ].includes(undefined)) return;
                    if (bytes[i] === flag_enum.CR && bytes[i + 1] === flag_enum.LF) {
                        state = STATES.TYPE_KV;
                    } else if (bytes[i] === flag_enum.HYPHEN && bytes[i + 1] === flag_enum.HYPHEN) {
                        state = STATES.END;
                    } else {
                        done(Result("part 数据错误, boundary间隔后部!"));
                        defer();
                        return;
                    }
                    
                    bytes = bytes.subarray(2);
                    i = 0;

                    break;
                case STATES.END:
                    done(Result(null, fields));
                    defer();
                    return;

                    break;
                default:
                    done(Result("状态溢出 :( "));
                    defer();
                    return;
            }

        }
    }
}
