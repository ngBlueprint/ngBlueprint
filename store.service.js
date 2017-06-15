import { Injectable } from '@angular/core';


// Add to providers in main module.ts file and inject into components
// Define in constructor arguments, call initialize in the constructor
// Ensure the DoCheck life-cycle-hook is implemented in the component
@Injectable()
export class StoreService {
    storage = [];
    getData() {
        return this.storage;
    }
    setData(obj) {
        const cache = {}; 
        for (let key in obj) {
            if (typeof obj[key] !== 'function')
                cache[key] = Object.assign(obj[key], {
                    test: 0,
                });
        }
        cache['name'] = obj.constructor.name;
        this.storage.push(cache);
    }
    initialize(obj) {
        const that = this;
        obj.ngDoCheck = () => that.setData(obj);
    }
}