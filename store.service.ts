import { Injectable } from '@angular/core';
import { Http } from '@angular/http';
import { inspect } from 'util';
import { CircularJSON } from 'circular-json';


export const functionName = (fn: Function): string => {
    const extract = (value: string) => value.match(/^function ([^\(]*)\(/);

    let name: string = (<any>fn).name;
    if (name == null || name.length === 0) {
        const match = extract(fn.toString());
        if (match != null && match.length > 1) {
            return match[1];
        }
        return fn.toString();
    }
    return name;
};

class Operation {
    arrays = new Array<any>();
    hashes = new Array<any>();
    objref = new Array<any>();
    sets = new Array<any>();
    maps = new Array<any>();

    /// Nodes that have been visited and recorded (-> index)
    visits = new Map<any, number>();

    /// Recursion operations that we want to execute in a shallow call stack
    tails = new Array<() => void>();
}

const serializer = object => {
    switch (typeof object) {
        case 'object':
            if (object) {
                break;
            }
        // fallthrough
        case 'string':
        case 'number':
        case 'boolean':
        case 'undefined':
            return JSON.stringify(object);
        case 'function':
            return object.toString();
    }

    const operation = new Operation();

    /// Start the mapping operation at the root.
    map(operation, object);

    /// Avoid recursive operations by adding functions to tails
    while (operation.tails.length > 0) {
        const run = operation.tails.length;

        for (let index = 0; index < run; ++index) {
            operation.tails[index]();
        }

        operation.tails.splice(0, run);
    }

    /// Return a string representation of the recreator function. The result must
    /// be parseable JavaScript code that can be provided to `new Function()' to
    /// create a function that can recreate the object.
    const encode = v => JSON.stringify(v);

    const mapString = (link) => {
        const source = encode(link.source);
        const key = link.key instanceof Reference ? `_[${encode(link.key.target)}]` : `${link.key}`;
        const v = link.target !== null ? `_[${encode(link.target)}]` : `${link.value}`;
        return `_[${source}].set(${key}, ${v});`;
    };

    return `function() {
    var _ = [${operation.objref.join(',')}];
    ${operation.arrays.map(link =>
            `_[${encode(link.source)}][${encode(link.key)}] = _[${encode(link.target)}];`).join('')}
    ${operation.hashes.map(link =>
            `_[${encode(link.source)}][${encode(link.key)}] = _[${encode(link.target)}];`).join('')}
    ${operation.maps.map(link => `${mapString(link)}`).join('')}
    ${operation.sets.map(link =>
            `_[${encode(link.source)}].add(_[${encode(link.target)}]);`).join('')}
      return _[0];
    }();`;
};

/// Serialize a complex object into a function that can recreate the object.
export const serialize = value => `return ${serializer(value)}`;

/// Deserialize a function string and invoke the resulting object recreator.
export const deserialize = value => (new Function(value))();

function Reference(to: number = null, value = undefined) {
    this.source = null;
    this.target = to;
    this.value = value;
}

function map(operation: Operation, value) {
    switch (typeof value) {
        case 'string':
            return JSON.stringify(value);
        case 'number':
        case 'boolean':
            return value;
        case 'undefined':
            return 'undefined';
        default:
            if (value === null) {
                return 'null';
            }

            const objectType = Object.prototype.toString.call(value);

            switch (objectType) {
                case '[object RegExp]':
                    return value.toString();
                case '[object Date]':
                    return `new Date(${value.valueOf()})`;
                default:
                    if (/Element/.test(objectType)) {
                        return null; // cannot serialize DOM elements
                    }

                    /// If this is a function, there is really no way to serialize
                    /// it in a way that will include its original context and
                    /// closures. But we do serialize the function, because this
                    /// will allow people to pass functions from their tasks as
                    /// long as they do not reference closures that are not accessible
                    /// in the context they are running in.
                    if (typeof value === 'function') {
                        return `function ${functionName(value).split(' ').join('_')}() {}`;
                    }

                    let index = operation.visits.get(value);
                    if (index != null) {
                        return new Reference(index);
                    }
                    else {
                        index = operation.visits.size;

                        operation.visits.set(value, index);
                    }

                    const mapArray = (collection: Array<any>, array: Array<any>) => {
                        return `[${array.map((v, i) => {
                            const ref = map(operation, v);
                            if (ref instanceof Reference) {
                                ref.source = index;
                                ref.key = i;
                                collection.push(ref);
                            }
                            return ref;
                        }).map(v => v instanceof Reference === false ? v : undefined).join(',')}]`;
                    };

                    switch (objectType) {
                        case '[object Array]':
                            operation.tails.push(() => {
                                operation.objref[index] = mapArray(operation.arrays, value);
                            });
                            break;
                        case '[object Set]':
                            operation.tails.push(() => {
                                operation.objref[index] = `new Set()`;

                                value.forEach((v, key) => {
                                    const ref = map(operation, v);

                                    if (ref instanceof Reference) {
                                        ref.source = index;

                                        operation.sets.push(ref);
                                    }
                                });
                            });
                            break;
                        case '[object Map]':
                            operation.tails.push(() => {
                                operation.objref[index] = `new Map()`;

                                value.forEach((v, key) => {
                                    let ref = map(operation, v);
                                    const keyRef = map(operation, key);

                                    if (ref instanceof Reference === false) {
                                        ref = new Reference(null, ref);
                                    }
                                    ref.source = index;
                                    ref.key = ref instanceof Reference ? keyRef : key;
                                    operation.maps.push(ref);
                                });
                            });
                            break;
                        default:
                            operation.tails.push(() => {
                                const constructor = value && value.constructor ?
                                    value.constructor : ({}).constructor;
                                const ctor = functionName(constructor) || '';

                                const mapProps = (key: string) => {
                                    const mapped = map(operation, value[key]);
                                    if (mapped instanceof Reference) {
                                        mapped.source = index;
                                        mapped.key = key;
                                        operation.hashes.push(mapped);
                                        return mapped;
                                    }

                                    return `${JSON.stringify(key)}: ${mapped}`;
                                };

                                const keys = Object.keys(value)
                                    .map(key => mapProps(key))
                                    .filter(v => v instanceof Reference === false).join(',');

                                if (nonstandardType(ctor)) { // retain object type information
                                    operation.objref[index] = `new (function ${ctor}() {Object.assign(this, {${keys}});})()`;
                                }
                                else {
                                    operation.objref[index] = `{${keys}}`;
                                }
                            });
                            break;
                    }

                    return new Reference(index);
            }
    }
}

const nonstandardType = (type: string) => {
    switch (type.toLowerCase()) {
        case 'object':
        case 'function':
        case 'string':
        case 'number':
        case 'regexp':
        case 'date':
            return false;
        default:
            return true;
    }
};


// Add to providers in main module.ts file and inject into components
// Do not add to the providers of the sub components
// Define in constructor arguments, call initialize in the constructor
// Ensure the DoCheck life-cycle-hook is implemented in the component
@Injectable()
export class StoreService {
    storage = {};

    constructor(private http: Http) { }

    sendData() {
        // let cache = [];
        // console.log(JSON.stringify(this.storage, function (key, value) {
        //     if (typeof value === 'object' && value !== null) {
        //         if (cache.indexOf(value) !== -1) {
        //             // Circular reference found, discard key
        //             return;
        //         }
        //         // Store value in our collection
        //         cache.push(value);
        //     }
        //     return value;
        // }))
        console.log(this.storage);
        window.postMessage({ data: serialize(this.storage), type: "message", source: "ngPulse" }, '*');
        // console.log(this.http.post("http://localhost:3000/update", this.storage));
    }

    removeCircular(obj: any, cache: any = {}, keys: any = {}) {
        for (let key in obj) {
            if (cache)
                if (typeof obj[key] === 'object' && !(obj[key] instanceof Array)) {
                    this.removeCircular(obj[key], cache[key], keys)
                }
            if (typeof obj[key] !== 'function' && key !== 'storeService') {
                cache[key] = Object.assign(obj[key], {});
            }
        }
    }

    setData(obj: any) {
        const cache = {};
        const compName = obj.constructor.name;
        for (let key in obj) {
            if (typeof obj[key] !== 'function' && key !== 'storeService') {
                cache[key] = Object.assign(obj[key], {});
            }
        }
        if (!this.storage[compName]) this.storage[compName] = [];
        this.storage[compName].push(cache);
        this.sendData();
    }

    initialize(obj: any) {
        const that = this;
        if (obj.ngDoCheck)
            obj.ngDoCheck = () => that.setData(obj);
    }
}