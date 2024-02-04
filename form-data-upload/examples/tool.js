export const flag_enum = {
    SPACE: 0x20,
    LF: 0x0a,
    CR: 0x0d,
    COLON: 0x3a,
    HYPHEN: 0x2d,
};

export function parseHeader (bytes) {
    let pro, kvs, i;
    [pro, i] = Procotol(bytes);
    [kvs, i] = parseKVS(bytes, i);

    if (![pro, kvs].every(arr => arr.length)) return [null, i];

    let s = [...pro, ...kvs].map(codes => {
        return codes.reduce((r, i) => {
            r += String.fromCodePoint(i);
            return r;
        }, "");
    });

    const h = {
        method: s[0],
        path: s[1],
        version: s[2],
    };
    s = s.slice(3);
    if (s.length % 2) throw new Error("header部分键值不对应！");
    let j = 0;
    for (; j < s.length; j += 2) {
        h[s[j].toLowerCase()] = s[j + 1];
    }

    return [h, i];
}

export function parseKVS (bytes, i = 0) {
    const kvs = [];
    let kv;
    while (true) {
        if (i >= bytes.length) break;
        if (
            bytes[i] === flag_enum.CR && 
            bytes[i + 1] === flag_enum.LF &&
            bytes[i + 2] === flag_enum.CR && 
            bytes[i + 3] === flag_enum.LF
        ) {
            i += 4;
            return [kvs, i];
        }
        [kv, i] = Keyv(bytes, i);
        kvs.push(...kv);
    }
    return [[], i];
}

function read (bytes, stopCode, i = 0) {
    const res = [];
    for (; i < bytes.length; i++) {
        if (
            [flag_enum.SPACE, flag_enum.LF, flag_enum.CR].includes(bytes[i])
            && res.length === 0
        ) continue;
        if (bytes[i] === stopCode) return [res, i];
        res.push(bytes[i]);
    }
    return [[], i];
}

function Procotol (bytes, i = 0) {
    let mbs, ubs, vbs;
    [mbs, i] = read(bytes, flag_enum.SPACE, i),
    [ubs, i] = read(bytes, flag_enum.SPACE, i),
    [vbs, i] = read(bytes, flag_enum.CR, i);
    if ([mbs, ubs, vbs].every(arr => arr.length)) {
        return [[mbs, ubs, vbs], i];
    }
    return [[], i];
}

function Keyv (bytes, i) {
    let key, val;
    [key, i] = read(bytes, flag_enum.COLON, i);
    i += 1;
    [val, i] = read(bytes, flag_enum.CR, i);
    return [[key, val], i];
}

export function readBoundary (bytes, boundary, i = 0) {
    let index = 0, boundaryBytes = [];
    while (true) {
        if (index < boundary.length && bytes[i] !== boundary[index]) return [ undefined, i ];
        if (index === boundary.length) return [ boundaryBytes, i ];
        boundaryBytes.push(bytes[i]);
        index++;
        i++;
    }
}