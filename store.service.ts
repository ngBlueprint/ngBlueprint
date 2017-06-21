import { Injectable } from '@angular/core';
import { Http } from '@angular/http';



// Add to providers in main module.ts file and inject into components
// Do not add to the providers of the sub components
// Define in constructor arguments, call initialize in the constructor
// Ensure the DoCheck life-cycle-hook is implemented in the component
@Injectable()
export class StoreService {
    storage = {};

    constructor(private http: Http) {}

    sendData() {
        this.http.post("http://localhost:3000/update", this.storage);
    }

    setData(obj) {
        const cache = {}; 
        const compName = obj.constructor.name;
        for (let key in obj) {
            if (typeof obj[key] !== 'function')
                cache[key] = Object.assign(obj[key], {
                    test: 0,
                });
        }
        if (!this.storage[compName]) this.storage[compName] = [];
        this.storage[compName].push(cache);
        this.sendData();
    }
    initialize(obj) {
        const that = this;
        obj.ngDoCheck = () => that.setData(obj);
    }
}