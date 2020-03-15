let context;

document.addEventListener("DOMContentLoaded", function(){
    document.body.addEventListener("dragenter", cancelEvent);
    document.body.addEventListener("dragover", cancelEvent);
    document.body.addEventListener("drop", dropFile);
    canvas.width = 220;
    canvas.height = 176;
    context = canvas.getContext("2d");
});

function cancelEvent( event ){
    event.stopPropagation();
    event.preventDefault();
}

var done = false;

function dropFile( event ){
    if(done)
        return;
    done = true;

    cancelEvent( event );
	
    var dt = event.dataTransfer;
    var files = dt.files;
    var out = [];
    var pendingPal = 1;
    var pending = 0;

    for (var i = 0; i < files.length; i++) {
	let file = files[i];
	let fr = new FileReader();
	
	fr.onload = (function(fr, file){
            process(
                fr.result,
                file.name.replace(/\.[a-z0-9]+$/i, '')
            );
	}).bind( null, fr, file );
	
	fr.readAsArrayBuffer( file );
        break;
    }

    function process( videodata, name ){
        canvas.style.display = "block";
        convert(videodata, result => {
            canvas.style.display = "none";
	    let a = document.createElement('A');
	    a.href = URL.createObjectURL(
                new Blob([result.buffer], {type:'application/bin'})
            );
	    a.textContent = name;
	    a.setAttribute("download", name + ".vdo");
            let caption = document.getElementById("caption");
            caption.innerHTML = '';
            caption.appendChild(a);
        });
    }
}


/// ------ Converter ------

const FPS = 18, dither = false;

var palette, audio;
var prevC, prevI, lout;
var opts = {
	colors: 256,
	method: 2,
	initColors: 4096,
	minHueCols: 0,
	dithKern: dither?"SierraLite":null,
	dithSerp: false,
};

function paletteFromTriplet(pal){
    palette = new Uint8Array(pal.length*3);
    for( let i=0; i<pal.length; ++i ){
        palette[i*3] = pal[i][0];
        palette[i*3+1] = pal[i][1];
        palette[i*3+2] = pal[i][2];
    }
    
}

function palette565FromTriplet(pal){
    palette = new Uint16Array(256);
    for( let i=0; i<pal.length; ++i ){
        let R = pal[i][0];
        let G = pal[i][1];
        let B = pal[i][2];
        let C = ((R&0xF8)<<8) + ((G&0xFC)<<3) + (B>>3);
        palette[i] = C;
    }
    palette = new Uint8Array(palette.buffer);
}

function convert(data, cb){
    let blob = new Blob([data], {type:"video/mp4"});
    startAudio(data)
        .then(_=>{
            startVideo(blob, cb);
        });
}

function startAudio(data){
    return readAudio(data, {rate:9216})
        .then(data=>{
            audio = new Uint8Array(data);
        });
}

function startVideo(data, cb){
    let bytesIn = 0;
    let bytesOut = 0;
    let start = 0;
    let frameCount = 0;

    let out = [new Uint8Array([0x46, 0x49, 0x4c, 0x4d, 0])];
    extractFramesFromVideo(data, FPS, 220, 176, (frame, time)=>{
        if(start === 0){
            start = performance.now();
        }
        
        for(let i=0; i<frame.data.length; i+=4)
            frame[i+3] = 255;

        let unc = quantize(frame, (frameCount&0x3) === 0); // encode(frame);
        bytesIn += unc.length;
        out.push(audio.slice(frameCount*512, (frameCount+1)*512));

        if((frameCount&3) === 0)
            out.push(new Uint8Array(palette.buffer));

        frameCount++;

        for(let r=0; r<22; ++r){
            let start = r * 8 * 220;
            let end = start + 8 * 220;
            let slice = unc.slice(start, end);
            let comp = compress(slice).slice(9);
            bytesOut += 2;
            comp[0] = comp.length&0xFF;
            comp[1] = comp.length >> 8;
            bytesOut += comp.length;
            out.push(comp);
        }
    }).then(_=>{
        let tpf = (performance.now() - start) / frameCount;
        console.log(frameCount + " frames encoded at " + (1000/tpf|0) + "fps Data is " + (bytesOut/bytesIn*100|0) + "% of raw size.");
        
        let total = 0;
        for(let i=0; i<out.length; ++i){
            total += out[i].length;
        }

        let acc = new Uint8Array(total);
        total = 0;
        for(let i=0; i<out.length; ++i){
            acc.set(out[i], total);
            total += out[i].length;
        }

        cb(acc);
    });
}

var first = 1;
var quant;
function quantize(img, newPalette){
    if(!quant || newPalette){
        quant = getRgbQuant();
        quant.sample(img);
        palette565FromTriplet(quant.palette(true));
    }
    return quant.reduce(img, 2);
}

function encode(img){
    if(!prevI){
        prevI = new Uint8Array(img.width * img.height);
        prevC = new Uint16Array(img.width * img.height);
        lout = new Uint8Array(img.width * img.height);
        let R = palette[0];
        let G = palette[1];
        let B = palette[2];
        let C = ((R&0xF8)<<11) + ((G&0xFC)<<8) + (B>>3);
        prevC.fill(C);
    }
    
    let bpp = 8;
    let data = img.data;
    let out = lout;
    let p = 0;
    let max = Math.min(palette.length/3, 1<<bpp);
    let PC, PCC = 0;
    const lpalette = palette;
    const lprevC = prevC;
    const ye = data.length;
    for( let y=0; y<ye; y+=4 ){
            let i = p << 2;
            let closest = 0;
            let R = data[i++]|0;
            let G = data[i++]|0;
            let B = data[i++]|0;
            i++;
            let C = ((R&0xF8)<<11) + ((G&0xFC)<<8) + (B>>3);
            if(C === PC){
                closest = PCC;
            }else if(C === lprevC[p]){
                out[p++] = prevI[p];
                continue;
            }else{
                let closestDist = Number.POSITIVE_INFINITY;
                let j = 0;
                for( let c=0; c<max; ++c ){
                    const PR = lpalette[j++];
                    const PG = lpalette[j++];
                    const PB = lpalette[j++];
        	        const dist = (R-PR)*(R-PR)
                        + (G-PG)*(G-PG)
                        + (B-PB)*(B-PB)
                    ;

                    if( dist < closestDist ){
                        closest = c;
                        closestDist = dist;
                    }
                }
                
                PC = C;
                PCC = closest;
            }

            prevC[p] = C;
            prevI[p] = closest;
            out[p++] = closest;
    }
    
    return out;
}

async function extractFramesFromVideo(videoBlob, fps, tw, th, cb) {
    return new Promise(async (resolve) => {
        const style = {
            style:{
                position: "absolute",
                width: tw,
                height: th,
                top: "10%",
                right: "10%"
            }
        };

        let videoObjectUrl = URL.createObjectURL(videoBlob);
        let video = document.createElement("video");
        
        let seekResolve;
        video.addEventListener('seeked', async function() {
            if(seekResolve) seekResolve();
        });

        video.src = videoObjectUrl;

        // workaround chromium metadata bug (https://stackoverflow.com/q/38062864/993683)
        let tries = 100;
        while(tries-- && (video.duration === Infinity || isNaN(video.duration)) && video.readyState < 2) {
            await new Promise(r => setTimeout(r, 1000));
            video.currentTime = 10000000 * Math.random();
        }
        
        let duration = video.duration;
        if(!tries) duration = 0;
        
        let [w, h] = [video.videoWidth, video.videoHeight];
        canvas.width =  tw;
        canvas.height = th;
        let scale = th / h;
        let sw = w/2 - (tw/scale)/2;

        let frames = [];
        let interval = 1 / fps;
        let currentTime = 0;
        let frameCount = 0;
        while(currentTime < duration) {
            try {
                video.currentTime = currentTime;
                await new Promise(r => seekResolve=r);
                
                context.drawImage(video, sw, 0, w - sw*2, h, 0, 0, tw, th);
                cb(context.getImageData(0, 0, tw, th), currentTime);
                
                currentTime += interval;
            }catch(ex){
                console.log(ex);
                break;
            }
        }

        URL.revokeObjectURL(videoObjectUrl);
        resolve(frames);
    });
}


/*
 * Copyright (c) 2015, Leon Sorokin
 * All rights reserved. (MIT Licensed)
 *
 * RgbQuant.js - an image quantization lib
 */

function getRgbQuant(){
    function RgbQuant(opts) {
	opts = opts || {};

	// 1 = by global population, 2 = subregion population threshold
	this.method = opts.method || 2;
	// desired final palette size
	this.colors = opts.colors || 256;
	// # of highest-frequency colors to start with for palette reduction
	this.initColors = opts.initColors || 4096;
	// color-distance threshold for initial reduction pass
	this.initDist = opts.initDist || 0.01;
	// subsequent passes threshold
	this.distIncr = opts.distIncr || 0.005;
	// palette grouping
	this.hueGroups = opts.hueGroups || 10;
	this.satGroups = opts.satGroups || 10;
	this.lumGroups = opts.lumGroups || 10;
	// if > 0, enables hues stats and min-color retention per group
	this.minHueCols = opts.minHueCols || 0;
	// HueStats instance
	this.hueStats = this.minHueCols ? new HueStats(this.hueGroups, this.minHueCols) : null;

	// subregion partitioning box size
	this.boxSize = opts.boxSize || [64,64];
	// number of same pixels required within box for histogram inclusion
	this.boxPxls = opts.boxPxls || 2;
	// palette locked indicator
	this.palLocked = false;
	// palette sort order
        //		this.sortPal = ['hue-','lum-','sat-'];

	// dithering/error diffusion kernel name
	this.dithKern = opts.dithKern || null;
	// dither serpentine pattern
	this.dithSerp = opts.dithSerp || false;
	// minimum color difference (0-1) needed to dither
	this.dithDelta = opts.dithDelta || 0;

	// accumulated histogram
	this.histogram = {};
	// palette - rgb triplets
	this.idxrgb = opts.palette ? opts.palette.slice(0) : [];
	// palette - int32 vals
	this.idxi32 = [];
	// reverse lookup {i32:idx}
	this.i32idx = {};
	// {i32:rgb}
	this.i32rgb = {};
	// enable color caching (also incurs overhead of cache misses and cache building)
	this.useCache = opts.useCache !== false;
	// min color occurance count needed to qualify for caching
	this.cacheFreq = opts.cacheFreq || 10;
	// allows pre-defined palettes to be re-indexed (enabling palette compacting and sorting)
	this.reIndex = opts.reIndex || this.idxrgb.length == 0;
	// selection of color-distance equation
	this.colorDist = opts.colorDist == "manhattan" ? distManhattan : distEuclidean;

	// if pre-defined palette, build lookups
	if (this.idxrgb.length > 0) {
	    var self = this;
	    this.idxrgb.forEach(function(rgb, i) {
		var i32 = (
		    (255    << 24) |	// alpha
			(rgb[2] << 16) |	// blue
			(rgb[1] <<  8) |	// green
			rgb[0]				// red
		) >>> 0;

		self.idxi32[i]		= i32;
		self.i32idx[i32]	= i;
		self.i32rgb[i32]	= rgb;
	    });
	}
    }

    // gathers histogram info
    RgbQuant.prototype.sample = function sample(img, width) {
	if (this.palLocked)
	    throw "Cannot sample additional images, palette already assembled.";

	var data = getImageData(img, width);

	switch (this.method) {
	case 1: this.colorStats1D(data.buf32); break;
	case 2: this.colorStats2D(data.buf32, data.width); break;
	}
    };

    // image quantizer
    // todo: memoize colors here also
    // @retType: 1 - Uint8Array (default), 2 - Indexed array, 3 - Match @img type (unimplemented, todo)
    RgbQuant.prototype.reduce = function reduce(img, retType, dithKern, dithSerp) {
	if (!this.palLocked)
	    this.buildPal();

	dithKern = dithKern || this.dithKern;
	dithSerp = typeof dithSerp != "undefined" ? dithSerp : this.dithSerp;

	retType = retType || 1;

	// reduce w/dither
	if (dithKern)
	    var out32 = this.dither(img, dithKern, dithSerp);
	else {
	    var data = getImageData(img),
		buf32 = data.buf32,
		len = buf32.length,
		out32 = new Uint32Array(len);

	    for (var i = 0; i < len; i++) {
		var i32 = buf32[i];
		out32[i] = this.nearestColor(i32);
	    }
	}

	if (retType == 1)
	    return new Uint8Array(out32.buffer);

	if (retType == 2) {
	    var out = [],
		len = out32.length;

	    for (var i = 0; i < len; i++) {
		var i32 = out32[i];
		out[i] = this.i32idx[i32];
	    }

	    return out;
	}
    };

    // adapted from http://jsbin.com/iXofIji/2/edit by PAEz
    RgbQuant.prototype.dither = function(img, kernel, serpentine) {
	// http://www.tannerhelland.com/4660/dithering-eleven-algorithms-source-code/
	var kernels = {
	    FloydSteinberg: [
		[7 / 16, 1, 0],
		[3 / 16, -1, 1],
		[5 / 16, 0, 1],
		[1 / 16, 1, 1]
	    ],
	    FalseFloydSteinberg: [
		[3 / 8, 1, 0],
		[3 / 8, 0, 1],
		[2 / 8, 1, 1]
	    ],
	    Stucki: [
		[8 / 42, 1, 0],
		[4 / 42, 2, 0],
		[2 / 42, -2, 1],
		[4 / 42, -1, 1],
		[8 / 42, 0, 1],
		[4 / 42, 1, 1],
		[2 / 42, 2, 1],
		[1 / 42, -2, 2],
		[2 / 42, -1, 2],
		[4 / 42, 0, 2],
		[2 / 42, 1, 2],
		[1 / 42, 2, 2]
	    ],
	    Atkinson: [
		[1 / 8, 1, 0],
		[1 / 8, 2, 0],
		[1 / 8, -1, 1],
		[1 / 8, 0, 1],
		[1 / 8, 1, 1],
		[1 / 8, 0, 2]
	    ],
	    Jarvis: [			// Jarvis, Judice, and Ninke / JJN?
		[7 / 48, 1, 0],
		[5 / 48, 2, 0],
		[3 / 48, -2, 1],
		[5 / 48, -1, 1],
		[7 / 48, 0, 1],
		[5 / 48, 1, 1],
		[3 / 48, 2, 1],
		[1 / 48, -2, 2],
		[3 / 48, -1, 2],
		[5 / 48, 0, 2],
		[3 / 48, 1, 2],
		[1 / 48, 2, 2]
	    ],
	    Burkes: [
		[8 / 32, 1, 0],
		[4 / 32, 2, 0],
		[2 / 32, -2, 1],
		[4 / 32, -1, 1],
		[8 / 32, 0, 1],
		[4 / 32, 1, 1],
		[2 / 32, 2, 1],
	    ],
	    Sierra: [
		[5 / 32, 1, 0],
		[3 / 32, 2, 0],
		[2 / 32, -2, 1],
		[4 / 32, -1, 1],
		[5 / 32, 0, 1],
		[4 / 32, 1, 1],
		[2 / 32, 2, 1],
		[2 / 32, -1, 2],
		[3 / 32, 0, 2],
		[2 / 32, 1, 2],
	    ],
	    TwoSierra: [
		[4 / 16, 1, 0],
		[3 / 16, 2, 0],
		[1 / 16, -2, 1],
		[2 / 16, -1, 1],
		[3 / 16, 0, 1],
		[2 / 16, 1, 1],
		[1 / 16, 2, 1],
	    ],
	    SierraLite: [
		[2 / 4, 1, 0],
		[1 / 4, -1, 1],
		[1 / 4, 0, 1],
	    ],
	};

	if (!kernel || !kernels[kernel]) {
	    throw 'Unknown dithering kernel: ' + kernel;
	}

	var ds = kernels[kernel];

	var data = getImageData(img),
            //			buf8 = data.buf8,
	    buf32 = data.buf32,
	    width = data.width,
	    height = data.height,
	    len = buf32.length;

	var dir = serpentine ? -1 : 1;

	for (var y = 0; y < height; y++) {
	    if (serpentine)
		dir = dir * -1;

	    var lni = y * width;

	    for (var x = (dir == 1 ? 0 : width - 1), xend = (dir == 1 ? width : 0); x !== xend; x += dir) {
		// Image pixel
		var idx = lni + x,
		    i32 = buf32[idx],
		    r1 = (i32 & 0xff),
		    g1 = (i32 & 0xff00) >> 8,
		    b1 = (i32 & 0xff0000) >> 16;

		// Reduced pixel
		var i32x = this.nearestColor(i32),
		    r2 = (i32x & 0xff),
		    g2 = (i32x & 0xff00) >> 8,
		    b2 = (i32x & 0xff0000) >> 16;

		buf32[idx] =
		    (255 << 24)	|	// alpha
		    (b2  << 16)	|	// blue
		    (g2  <<  8)	|	// green
		    r2;

		// dithering strength
		if (this.dithDelta) {
		    var dist = this.colorDist([r1, g1, b1], [r2, g2, b2]);
		    if (dist < this.dithDelta)
			continue;
		}

		// Component distance
		var er = r1 - r2,
		    eg = g1 - g2,
		    eb = b1 - b2;

		for (var i = (dir == 1 ? 0 : ds.length - 1), end = (dir == 1 ? ds.length : 0); i !== end; i += dir) {
		    var x1 = ds[i][1] * dir,
			y1 = ds[i][2];

		    var lni2 = y1 * width;

		    if (x1 + x >= 0 && x1 + x < width && y1 + y >= 0 && y1 + y < height) {
			var d = ds[i][0];
			var idx2 = idx + (lni2 + x1);

			var r3 = (buf32[idx2] & 0xff),
			    g3 = (buf32[idx2] & 0xff00) >> 8,
			    b3 = (buf32[idx2] & 0xff0000) >> 16;

			var r4 = Math.max(0, Math.min(255, r3 + er * d)),
			    g4 = Math.max(0, Math.min(255, g3 + eg * d)),
			    b4 = Math.max(0, Math.min(255, b3 + eb * d));

			buf32[idx2] =
			    (255 << 24)	|	// alpha
			    (b4  << 16)	|	// blue
			    (g4  <<  8)	|	// green
			    r4;			// red
		    }
		}
	    }
	}

	return buf32;
    };

    // reduces histogram to palette, remaps & memoizes reduced colors
    RgbQuant.prototype.buildPal = function buildPal(noSort) {
	if (this.palLocked || this.idxrgb.length > 0 && this.idxrgb.length <= this.colors) return;

	var histG  = this.histogram,
	    sorted = sortedHashKeys(histG, true);

	if (sorted.length == 0)
	    throw "Nothing has been sampled, palette cannot be built.";

	switch (this.method) {
	case 1:
	    var cols = this.initColors,
	    last = sorted[cols - 1],
	    freq = histG[last];

	    var idxi32 = sorted.slice(0, cols);

	    // add any cut off colors with same freq as last
	    var pos = cols, len = sorted.length;
	    while (pos < len && histG[sorted[pos]] == freq)
		idxi32.push(sorted[pos++]);

	    // inject min huegroup colors
	    if (this.hueStats)
		this.hueStats.inject(idxi32);

	    break;
	case 2:
	    var idxi32 = sorted;
	    break;
	}

	// int32-ify values
	idxi32 = idxi32.map(function(v){return +v;});

	this.reducePal(idxi32);

	if (!noSort && this.reIndex)
	    this.sortPal();

	// build cache of top histogram colors
	if (this.useCache)
	    this.cacheHistogram(idxi32);

	this.palLocked = true;
    };

    RgbQuant.prototype.palette = function palette(tuples, noSort) {
	this.buildPal(noSort);
	return tuples ? this.idxrgb : new Uint8Array((new Uint32Array(this.idxi32)).buffer);
    };

    RgbQuant.prototype.prunePal = function prunePal(keep) {
	var i32;

	for (var j = 0; j < this.idxrgb.length; j++) {
	    if (!keep[j]) {
		i32 = this.idxi32[j];
		this.idxrgb[j] = null;
		this.idxi32[j] = null;
		delete this.i32idx[i32];
	    }
	}

	// compact
	if (this.reIndex) {
	    var idxrgb = [],
		idxi32 = [],
		i32idx = {};

	    for (var j = 0, i = 0; j < this.idxrgb.length; j++) {
		if (this.idxrgb[j]) {
		    i32 = this.idxi32[j];
		    idxrgb[i] = this.idxrgb[j];
		    i32idx[i32] = i;
		    idxi32[i] = i32;
		    i++;
		}
	    }

	    this.idxrgb = idxrgb;
	    this.idxi32 = idxi32;
	    this.i32idx = i32idx;
	}
    };

    // reduces similar colors from an importance-sorted Uint32 rgba array
    RgbQuant.prototype.reducePal = function reducePal(idxi32) {
	// if pre-defined palette's length exceeds target
	if (this.idxrgb.length > this.colors) {
	    // quantize histogram to existing palette
	    var len = idxi32.length, keep = {}, uniques = 0, idx, pruned = false;

	    for (var i = 0; i < len; i++) {
		// palette length reached, unset all remaining colors (sparse palette)
		if (uniques == this.colors && !pruned) {
		    this.prunePal(keep);
		    pruned = true;
		}

		idx = this.nearestIndex(idxi32[i]);

		if (uniques < this.colors && !keep[idx]) {
		    keep[idx] = true;
		    uniques++;
		}
	    }

	    if (!pruned) {
		this.prunePal(keep);
		pruned = true;
	    }
	}
	// reduce histogram to create initial palette
	else {
	    // build full rgb palette
	    var idxrgb = idxi32.map(function(i32) {
		return [
		    (i32 & 0xff),
		    (i32 & 0xff00) >> 8,
		    (i32 & 0xff0000) >> 16,
		];
	    });

	    var len = idxrgb.length,
		palLen = len,
		thold = this.initDist;

	    // palette already at or below desired length
	    if (palLen > this.colors) {
		while (palLen > this.colors) {
		    var memDist = [];

		    // iterate palette
		    for (var i = 0; i < len; i++) {
			var pxi = idxrgb[i], i32i = idxi32[i];
			if (!pxi) continue;

			for (var j = i + 1; j < len; j++) {
			    var pxj = idxrgb[j], i32j = idxi32[j];
			    if (!pxj) continue;

			    var dist = this.colorDist(pxi, pxj);

			    if (dist < thold) {
				// store index,rgb,dist
				memDist.push([j, pxj, i32j, dist]);

				// kill squashed value
				delete(idxrgb[j]);
				palLen--;
			    }
			}
		    }

		    // palette reduction pass
		    // console.log("palette length: " + palLen);

		    // if palette is still much larger than target, increment by larger initDist
		    thold += (palLen > this.colors * 3) ? this.initDist : this.distIncr;
		}

		// if palette is over-reduced, re-add removed colors with largest distances from last round
		if (palLen < this.colors) {
		    // sort descending
		    sort.call(memDist, function(a,b) {
			return b[3] - a[3];
		    });

		    var k = 0;
		    while (palLen < this.colors) {
			// re-inject rgb into final palette
			idxrgb[memDist[k][0]] = memDist[k][1];

			palLen++;
			k++;
		    }
		}
	    }

	    var len = idxrgb.length;
	    for (var i = 0; i < len; i++) {
		if (!idxrgb[i]) continue;

		this.idxrgb.push(idxrgb[i]);
		this.idxi32.push(idxi32[i]);

		this.i32idx[idxi32[i]] = this.idxi32.length - 1;
		this.i32rgb[idxi32[i]] = idxrgb[i];
	    }
	}
    };

    // global top-population
    RgbQuant.prototype.colorStats1D = function colorStats1D(buf32) {
	var histG = this.histogram,
	    num = 0, col,
	    len = buf32.length;

	for (var i = 0; i < len; i++) {
	    col = buf32[i];

	    // skip transparent
	    if ((col & 0xff000000) >> 24 == 0) continue;

	    // collect hue stats
	    if (this.hueStats)
		this.hueStats.check(col);

	    if (col in histG)
		histG[col]++;
	    else
		histG[col] = 1;
	}
    };

    // population threshold within subregions
    // FIXME: this can over-reduce (few/no colors same?), need a way to keep
    // important colors that dont ever reach local thresholds (gradients?)
    RgbQuant.prototype.colorStats2D = function colorStats2D(buf32, width) {
	var boxW = this.boxSize[0],
	    boxH = this.boxSize[1],
	    area = boxW * boxH,
	    boxes = makeBoxes(width, buf32.length / width, boxW, boxH),
	    histG = this.histogram,
	    self = this;

	boxes.forEach(function(box) {
	    var effc = Math.max(Math.round((box.w * box.h) / area) * self.boxPxls, 2),
		histL = {}, col;

	    iterBox(box, width, function(i) {
		col = buf32[i];

		// skip transparent
		if ((col & 0xff000000) >> 24 == 0) return;

		// collect hue stats
		if (self.hueStats)
		    self.hueStats.check(col);

		if (col in histG)
		    histG[col]++;
		else if (col in histL) {
		    if (++histL[col] >= effc)
			histG[col] = histL[col];
		}
		else
		    histL[col] = 1;
	    });
	});

	if (this.hueStats)
	    this.hueStats.inject(histG);
    };

    // TODO: group very low lum and very high lum colors
    // TODO: pass custom sort order
    RgbQuant.prototype.sortPal = function sortPal() {
	var self = this;

	this.idxi32.sort(function(a,b) {
	    var idxA = self.i32idx[a],
		idxB = self.i32idx[b],
		rgbA = self.idxrgb[idxA],
		rgbB = self.idxrgb[idxB];

	    var hslA = rgb2hsl(rgbA[0],rgbA[1],rgbA[2]),
		hslB = rgb2hsl(rgbB[0],rgbB[1],rgbB[2]);

	    // sort all grays + whites together
	    var hueA = (rgbA[0] == rgbA[1] && rgbA[1] == rgbA[2]) ? -1 : hueGroup(hslA.h, self.hueGroups);
	    var hueB = (rgbB[0] == rgbB[1] && rgbB[1] == rgbB[2]) ? -1 : hueGroup(hslB.h, self.hueGroups);

	    var hueDiff = hueB - hueA;
	    if (hueDiff) return -hueDiff;

	    var lumDiff = lumGroup(+hslB.l.toFixed(2)) - lumGroup(+hslA.l.toFixed(2));
	    if (lumDiff) return -lumDiff;

	    var satDiff = satGroup(+hslB.s.toFixed(2)) - satGroup(+hslA.s.toFixed(2));
	    if (satDiff) return -satDiff;
	});

	// sync idxrgb & i32idx
	this.idxi32.forEach(function(i32, i) {
	    self.idxrgb[i] = self.i32rgb[i32];
	    self.i32idx[i32] = i;
	});
    };

    // TOTRY: use HUSL - http://boronine.com/husl/
    RgbQuant.prototype.nearestColor = function nearestColor(i32) {
	var idx = this.nearestIndex(i32);
	return this.idxi32[idx]|0;
    };

    // TOTRY: use HUSL - http://boronine.com/husl/
    RgbQuant.prototype.nearestIndex = function nearestIndex(i32) {
	// alpha 0 returns null index
	if ((i32 & 0xff000000) >> 24 == 0)
	    return null;

	if (this.useCache && (""+i32) in this.i32idx)
	    return this.i32idx[i32];

	var min = 1000,
	    idx,
	    len = this.idxrgb.length;
	var R = (i32 & 0xff);
	var G = (i32 & 0xff00) >> 8;
	var B = (i32 & 0xff0000) >> 16;
        let idxrgb = this.idxrgb;
	for (var i = 0; i < len; i++) {
	    let pc = idxrgb[i];
	    if (!pc) continue;		// sparse palettes
	    
	    // var dist = this.colorDist(rgb, this.idxrgb[i]);
    	    var rd = R-pc[0],
    		gd = G-pc[1],
    		bd = B-pc[2];
            
    	    var dist = Math.sqrt(Pr*rd*rd + Pg*gd*gd + Pb*bd*bd) / euclMax;

	    if (dist < min) {
		min = dist;
		idx = i;
	    }
	}

	return idx;
    };

    RgbQuant.prototype.cacheHistogram = function cacheHistogram(idxi32) {
	for (var i = 0, i32 = idxi32[i]; i < idxi32.length && this.histogram[i32] >= this.cacheFreq; i32 = idxi32[i++])
	    this.i32idx[i32] = this.nearestIndex(i32);
    };

    function HueStats(numGroups, minCols) {
	this.numGroups = numGroups;
	this.minCols = minCols;
	this.stats = {};

	for (var i = -1; i < numGroups; i++)
	    this.stats[i] = {num: 0, cols: []};

	this.groupsFull = 0;
    }

    HueStats.prototype.check = function checkHue(i32) {
	if (this.groupsFull == this.numGroups + 1)
	    this.check = function() {return;};

	var r = (i32 & 0xff),
	    g = (i32 & 0xff00) >> 8,
	    b = (i32 & 0xff0000) >> 16,
	    hg = (r == g && g == b) ? -1 : hueGroup(rgb2hsl(r,g,b).h, this.numGroups),
	    gr = this.stats[hg],
	    min = this.minCols;

	gr.num++;

	if (gr.num > min)
	    return;
	if (gr.num == min)
	    this.groupsFull++;

	if (gr.num <= min)
	    this.stats[hg].cols.push(i32);
    };

    HueStats.prototype.inject = function injectHues(histG) {
	for (var i = -1; i < this.numGroups; i++) {
	    if (this.stats[i].num <= this.minCols) {
		switch (typeOf(histG)) {
		case "Array":
		    this.stats[i].cols.forEach(function(col){
			if (histG.indexOf(col) == -1)
			    histG.push(col);
		    });
		    break;
		case "Object":
		    this.stats[i].cols.forEach(function(col){
			if (!histG[col])
			    histG[col] = 1;
			else
			    histG[col]++;
		    });
		    break;
		}
	    }
	}
    };

    // Rec. 709 (sRGB) luma coef
    var Pr = .2126,
	Pg = .7152,
	Pb = .0722;

    // http://alienryderflex.com/hsp.html
    function rgb2lum(r,g,b) {
	return Math.sqrt(
	    Pr * r*r +
		Pg * g*g +
		Pb * b*b
	);
    }

    var rd = 255,
	gd = 255,
	bd = 255;

    var euclMax = Math.sqrt(Pr*rd*rd + Pg*gd*gd + Pb*bd*bd);
    // perceptual Euclidean color distance
    function distEuclidean(rgb0, rgb1) {
	/* * /
	  var rd = rgb1[0]-rgb0[0],
	  gd = rgb1[1]-rgb0[1],
	  bd = rgb1[2]-rgb0[2];

	  return (Pr*rd*rd + Pg*gd*gd + Pb*bd*bd) / euclMax;
	  /*/
	var rd = rgb1[0]-rgb0[0],
	    gd = rgb1[1]-rgb0[1],
	    bd = rgb1[2]-rgb0[2];

	return Math.sqrt(Pr*rd*rd + Pg*gd*gd + Pb*bd*bd) / euclMax;
	/* */
    }

    var manhMax = Pr*rd + Pg*gd + Pb*bd;
    // perceptual Manhattan color distance
    function distManhattan(rgb0, rgb1) {
	var rd = Math.abs(rgb1[0]-rgb0[0]),
	    gd = Math.abs(rgb1[1]-rgb0[1]),
	    bd = Math.abs(rgb1[2]-rgb0[2]);

	return (Pr*rd + Pg*gd + Pb*bd) / manhMax;
    }

    // http://rgb2hsl.nichabi.com/javascript-function.php
    function rgb2hsl(r, g, b) {
	var max, min, h, s, l, d;
	r /= 255;
	g /= 255;
	b /= 255;
	max = Math.max(r, g, b);
	min = Math.min(r, g, b);
	l = (max + min) / 2;
	if (max == min) {
	    h = s = 0;
	} else {
	    d = max - min;
	    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	    switch (max) {
	    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
	    case g:	h = (b - r) / d + 2; break;
	    case b:	h = (r - g) / d + 4; break
	    }
	    h /= 6;
	}
        //		h = Math.floor(h * 360)
        //		s = Math.floor(s * 100)
        //		l = Math.floor(l * 100)
	return {
	    h: h,
	    s: s,
	    l: rgb2lum(r,g,b),
	};
    }

    function hueGroup(hue, segs) {
	var seg = 1/segs,
	    haf = seg/2;

	if (hue >= 1 - haf || hue <= haf)
	    return 0;

	for (var i = 1; i < segs; i++) {
	    var mid = i*seg;
	    if (hue >= mid - haf && hue <= mid + haf)
		return i;
	}
    }

    function satGroup(sat) {
	return sat;
    }

    function lumGroup(lum) {
	return lum;
    }

    function typeOf(val) {
	return Object.prototype.toString.call(val).slice(8,-1);
    }

    var sort = isArrSortStable() ? Array.prototype.sort : stableSort;

    // must be used via stableSort.call(arr, fn)
    function stableSort(fn) {
	var type = typeOf(this[0]);

	if (type == "Number" || type == "String") {
	    var ord = {}, len = this.length, val;

	    for (var i = 0; i < len; i++) {
		val = this[i];
		if (ord[val] || ord[val] === 0) continue;
		ord[val] = i;
	    }

	    return this.sort(function(a,b) {
		return fn(a,b) || ord[a] - ord[b];
	    });
	}
	else {
	    var ord = this.map(function(v){return v});

	    return this.sort(function(a,b) {
		return fn(a,b) || ord.indexOf(a) - ord.indexOf(b);
	    });
	}
    }

    // test if js engine's Array#sort implementation is stable
    function isArrSortStable() {
	var str = "abcdefghijklmnopqrstuvwxyz";

	return "xyzvwtursopqmnklhijfgdeabc" == str.split("").sort(function(a,b) {
	    return ~~(str.indexOf(b)/2.3) - ~~(str.indexOf(a)/2.3);
	}).join("");
    }

    // returns uniform pixel data from various img
    // TODO?: if array is passed, createimagedata, createlement canvas? take a pxlen?
    function getImageData(img, width) {
	var can, ctx, imgd, buf8, buf32, height;

	switch (typeOf(img)) {
	case "HTMLImageElement":
	    can = document.createElement("canvas");
	    can.width = img.naturalWidth;
	    can.height = img.naturalHeight;
	    ctx = can.getContext("2d");
	    ctx.drawImage(img,0,0);
	case "Canvas":
	case "HTMLCanvasElement":
	    can = can || img;
	    ctx = ctx || can.getContext("2d");
	case "CanvasRenderingContext2D":
	    ctx = ctx || img;
	    can = can || ctx.canvas;
	    imgd = ctx.getImageData(0, 0, can.width, can.height);
	case "ImageData":
	    imgd = imgd || img;
	    width = imgd.width;
	    if (typeOf(imgd.data) == "CanvasPixelArray")
		buf8 = new Uint8Array(imgd.data);
	    else
		buf8 = imgd.data;
	case "Array":
	case "CanvasPixelArray":
	    buf8 = buf8 || new Uint8Array(img);
	case "Uint8Array":
	case "Uint8ClampedArray":
	    buf8 = buf8 || img;
	    buf32 = new Uint32Array(buf8.buffer);
	case "Uint32Array":
	    buf32 = buf32 || img;
	    buf8 = buf8 || new Uint8Array(buf32.buffer);
	    width = width || buf32.length;
	    height = buf32.length / width;
	}

	return {
	    can: can,
	    ctx: ctx,
	    imgd: imgd,
	    buf8: buf8,
	    buf32: buf32,
	    width: width,
	    height: height,
	};
    }

    // partitions a rect of wid x hgt into
    // array of bboxes of w0 x h0 (or less)
    function makeBoxes(wid, hgt, w0, h0) {
	var wnum = ~~(wid/w0), wrem = wid%w0,
	    hnum = ~~(hgt/h0), hrem = hgt%h0,
	    xend = wid-wrem, yend = hgt-hrem;

	var bxs = [];
	for (var y = 0; y < hgt; y += h0)
	    for (var x = 0; x < wid; x += w0)
		bxs.push({x:x, y:y, w:(x==xend?wrem:w0), h:(y==yend?hrem:h0)});

	return bxs;
    }

    // iterates @bbox within a parent rect of width @wid; calls @fn, passing index within parent
    function iterBox(bbox, wid, fn) {
	var b = bbox,
	    i0 = b.y * wid + b.x,
	    i1 = (b.y + b.h - 1) * wid + (b.x + b.w - 1),
	    cnt = 0, incr = wid - b.w + 1, i = i0;

	do {
	    fn.call(this, i);
	    i += (++cnt % b.w == 0) ? incr : 1;
	} while (i <= i1);
    }

    // returns array of hash keys sorted by their values
    function sortedHashKeys(obj, desc) {
	var keys = [];

	for (var key in obj)
	    keys.push(key);

	return sort.call(keys, function(a,b) {
	    return desc ? obj[b] - obj[a] : obj[a] - obj[b];
	});
    }

    return new RgbQuant(opts);
}


/// -------- LZ4 ----------

var compress = (function(){

    var exports = {};

    // xxh32.js - implementation of xxhash32 in plain JavaScript
    // xxhash32 primes
    var prime1 = 0x9e3779b1;
    var prime2 = 0x85ebca77;
    var prime3 = 0xc2b2ae3d;
    var prime4 = 0x27d4eb2f;
    var prime5 = 0x165667b1;

    // Utility functions/primitives
    // --

    function rotl32 (x, r) {
        x = x | 0;
        r = r | 0;

        return x >>> (32 - r | 0) | x << r | 0;
    }

    function rotmul32 (h, r, m) {
        h = h | 0;
        r = r | 0;
        m = m | 0;

        return util.imul(h >>> (32 - r | 0) | h << r, m) | 0;
    }

    function shiftxor32 (h, s) {
        h = h | 0;
        s = s | 0;

        return h >>> s ^ h | 0;
    }

    // Implementation
    // --

    function xxhapply (h, src, m0, s, m1) {
        return rotmul32(util.imul(src, m0) + h, s, m1);
    }

    function xxh1 (h, src, index) {
        return rotmul32((h + util.imul(src[index], prime5)), 11, prime1);
    }

    function xxh4 (h, src, index) {
        return xxhapply(h, util.readU32(src, index), prime3, 17, prime4);
    }

    function xxh16 (h, src, index) {
        return [
            xxhapply(h[0], util.readU32(src, index + 0), prime2, 13, prime1),
            xxhapply(h[1], util.readU32(src, index + 4), prime2, 13, prime1),
            xxhapply(h[2], util.readU32(src, index + 8), prime2, 13, prime1),
            xxhapply(h[3], util.readU32(src, index + 12), prime2, 13, prime1)
        ];
    }

    function xxh32 (seed, src, index, len) {
        var h, l;
        l = len;
        if (len >= 16) {
            h = [
                seed + prime1 + prime2,
                seed + prime2,
                seed,
                seed - prime1
            ];

            while (len >= 16) {
                h = xxh16(h, src, index);

                index += 16;
                len -= 16;
            }

            h = rotl32(h[0], 1) + rotl32(h[1], 7) + rotl32(h[2], 12) + rotl32(h[3], 18) + l;
        } else {
            h = (seed + prime5 + len) >>> 0;
        }

        while (len >= 4) {
            h = xxh4(h, src, index);

            index += 4;
            len -= 4;
        }

        while (len > 0) {
            h = xxh1(h, src, index);

            index++;
            len--;
        }

        h = shiftxor32(util.imul(shiftxor32(util.imul(shiftxor32(h, 15), prime2), 13), prime3), 16);

        return h >>> 0;
    }

    exports.hash = xxh32;


    // Simple hash function, from: http://burtleburtle.net/bob/hash/integer.html.
    // Chosen because it doesn't use multiply and achieves full avalanche.
    exports.hashU32 = function hashU32(a) {
        a = a | 0;
        a = a + 2127912214 + (a << 12) | 0;
        a = a ^ -949894596 ^ a >>> 19;
        a = a + 374761393 + (a << 5) | 0;
        a = a + -744332180 ^ a << 9;
        a = a + -42973499 + (a << 3) | 0;
        return a ^ -1252372727 ^ a >>> 16 | 0;
    }

    // Reads a 64-bit little-endian integer from an array.
    exports.readU64 = function readU64(b, n) {
        var x = 0;
        x |= b[n++] << 0;
        x |= b[n++] << 8;
        x |= b[n++] << 16;
        x |= b[n++] << 24;
        x |= b[n++] << 32;
        x |= b[n++] << 40;
        x |= b[n++] << 48;
        x |= b[n++] << 56;
        return x;
    }

    // Reads a 32-bit little-endian integer from an array.
    exports.readU32 = function readU32(b, n) {
        var x = 0;
        x |= b[n++] << 0;
        x |= b[n++] << 8;
        x |= b[n++] << 16;
        x |= b[n++] << 24;
        return x;
    }

    // Writes a 32-bit little-endian integer from an array.
    exports.writeU32 = function writeU32(b, n, x) {
        b[n++] = (x >> 0) & 0xff;
        b[n++] = (x >> 8) & 0xff;
        b[n++] = (x >> 16) & 0xff;
        b[n++] = (x >> 24) & 0xff;
    }

    // Multiplies two numbers using 32-bit integer multiplication.
    // Algorithm from Emscripten.
    exports.imul = function imul(a, b) {
        var ah = a >>> 16;
        var al = a & 65535;
        var bh = b >>> 16;
        var bl = b & 65535;

        return al * bl + (ah * bl + al * bh << 16) | 0;
    };    

    // lz4.js - An implementation of Lz4 in plain JavaScript.
    //
    // TODO:
    // - Unify header parsing/writing.
    // - Support options (block size, checksums)
    // - Support streams
    // - Better error handling (handle bad offset, etc.)
    // - HC support (better search algorithm)
    // - Tests/benchmarking

    var xxhash = exports; // require('./xxh32.js');

    // Constants
    // --

    // Compression format parameters/constants.
    var minMatch = 4;
    var minLength = 13;
    var searchLimit = 5;
    var skipTrigger = 6;
    var hashSize = 1 << 16;

    var util = exports; // require('./util.js');
    // Token constants.
    var mlBits = 4;
    var mlMask = (1 << mlBits) - 1;
    var runBits = 4;
    var runMask = (1 << runBits) - 1;

    // Shared buffers
    var blockBuf = makeBuffer(5 << 20);
    var hashTable = makeHashTable();

    // Frame constants.
    var magicNum = 0x184D2204;

    // Frame descriptor flags.
    var fdContentChksum = 0x4;
    var fdContentSize = 0x8;
    var fdBlockChksum = 0x10;
    // var fdBlockIndep = 0x20;
    var fdVersion = 0x40;
    var fdVersionMask = 0xC0;

    // Block sizes.
    var bsUncompressed = 0x80000000;
    var bsDefault = 7;
    var bsShift = 4;
    var bsMask = 7;
    var bsMap = {
        4: 0x10000,
        5: 0x40000,
        6: 0x100000,
        7: 0x400000
    };

    // Utility functions/primitives
    // --

    // Makes our hashtable. On older browsers, may return a plain array.
    function makeHashTable () {
        try {
            return new Uint32Array(hashSize);
        } catch (error) {
            var hashTable = new Array(hashSize);

            for (var i = 0; i < hashSize; i++) {
                hashTable[i] = 0;
            }

            return hashTable;
        }
    }

    // Clear hashtable.
    function clearHashTable (table) {
        for (var i = 0; i < hashSize; i++) {
            hashTable[i] = 0;
        }
    }

    // Makes a byte buffer. On older browsers, may return a plain array.
    function makeBuffer (size) {
        try {
            return new Uint8Array(size);
        } catch (error) {
            var buf = new Array(size);

            for (var i = 0; i < size; i++) {
                buf[i] = 0;
            }

            return buf;
        }
    }

    function sliceArray (array, start, end) {
        if (typeof array.buffer !== undefined) {
            if (Uint8Array.prototype.slice) {
                return array.slice(start, end);
            } else {
                // Uint8Array#slice polyfill.
                var len = array.length;

                // Calculate start.
                start = start | 0;
                start = (start < 0) ? Math.max(len + start, 0) : Math.min(start, len);

                // Calculate end.
                end = (end === undefined) ? len : end | 0;
                end = (end < 0) ? Math.max(len + end, 0) : Math.min(end, len);

                // Copy into new array.
                var arraySlice = new Uint8Array(end - start);
                for (var i = start, n = 0; i < end;) {
                    arraySlice[n++] = array[i++];
                }

                return arraySlice;
            }
        } else {
            // Assume normal array.
            return array.slice(start, end);
        }
    }

    // Implementation
    // --

    // Calculates an upper bound for lz4 compression.
    exports.compressBound = function compressBound (n) {
        return (n + (n / 255) + 16) | 0;
    };

    // Calculates an upper bound for lz4 decompression, by reading the data.
    exports.decompressBound = function decompressBound (src) {
        var sIndex = 0;

        // Read magic number
        if (util.readU32(src, sIndex) !== magicNum) {
            throw new Error('invalid magic number');
        }

        sIndex += 4;

        // Read descriptor
        var descriptor = src[sIndex++];

        // Check version
        if ((descriptor & fdVersionMask) !== fdVersion) {
            throw new Error('incompatible descriptor version ' + (descriptor & fdVersionMask));
        }

        // Read flags
        var useBlockSum = (descriptor & fdBlockChksum) !== 0;
        var useContentSize = (descriptor & fdContentSize) !== 0;

        // Read block size
        var bsIdx = (src[sIndex++] >> bsShift) & bsMask;

        if (bsMap[bsIdx] === undefined) {
            throw new Error('invalid block size ' + bsIdx);
        }

        var maxBlockSize = bsMap[bsIdx];

        // Get content size
        if (useContentSize) {
            return util.readU64(src, sIndex);
        }

        // Checksum
        sIndex++;

        // Read blocks.
        var maxSize = 0;
        while (true) {
            var blockSize = util.readU32(src, sIndex);
            sIndex += 4;

            if (blockSize & bsUncompressed) {
                blockSize &= ~bsUncompressed;
                maxSize += blockSize;
            } else if (blockSize > 0) {
                maxSize += maxBlockSize;
            }

            if (blockSize === 0) {
                return maxSize;
            }

            if (useBlockSum) {
                sIndex += 4;
            }

            sIndex += blockSize;
        }
    };

    // Creates a buffer of a given byte-size, falling back to plain arrays.
    exports.makeBuffer = makeBuffer;

    // Decompresses a block of Lz4.
    exports.decompressBlock = function decompressBlock (src, dst, sIndex, sLength, dIndex) {
        var mLength, mOffset, sEnd, n, i;
        var hasCopyWithin = dst.copyWithin !== undefined && dst.fill !== undefined;

        // Setup initial state.
        sEnd = sIndex + sLength;

        // Consume entire input block.
        while (sIndex < sEnd) {
            var token = src[sIndex++];

            // Copy literals.
            var literalCount = (token >> 4);
            if (literalCount > 0) {
                // Parse length.
                if (literalCount === 0xf) {
                    while (true) {
                        literalCount += src[sIndex];
                        if (src[sIndex++] !== 0xff) {
                            break;
                        }
                    }
                }

                // Copy literals
                for (n = sIndex + literalCount; sIndex < n;) {
                    dst[dIndex++] = src[sIndex++];
                }
            }

            if (sIndex >= sEnd) {
                break;
            }

            // Copy match.
            mLength = (token & 0xf);

            // Parse offset.
            mOffset = src[sIndex++] | (src[sIndex++] << 8);

            // Parse length.
            if (mLength === 0xf) {
                while (true) {
                    mLength += src[sIndex];
                    if (src[sIndex++] !== 0xff) {
                        break;
                    }
                }
            }

            mLength += minMatch;

            // Copy match
            // prefer to use typedarray.copyWithin for larger matches
            // NOTE: copyWithin doesn't work as required by LZ4 for overlapping sequences
            // e.g. mOffset=1, mLength=30 (repeach char 30 times)
            // we special case the repeat char w/ array.fill
            if (hasCopyWithin && mOffset === 1) {
                dst.fill(dst[dIndex - 1] | 0, dIndex, dIndex + mLength);
                dIndex += mLength;
            } else if (hasCopyWithin && mOffset > mLength && mLength > 31) {
                dst.copyWithin(dIndex, dIndex - mOffset, dIndex - mOffset + mLength);
                dIndex += mLength;
            } else {
                for (i = dIndex - mOffset, n = i + mLength; i < n;) {
                    dst[dIndex++] = dst[i++] | 0;
                }
            }
        }

        return dIndex;
    };

    // Compresses a block with Lz4.
    exports.compressBlock = function compressBlock (src, dst, sIndex, sLength, hashTable) {
        var mIndex, mAnchor, mLength, mOffset, mStep;
        var literalCount, dIndex, sEnd, n;

        // Setup initial state.
        dIndex = 0;
        sEnd = sLength + sIndex;
        mAnchor = sIndex;

        // Process only if block is large enough.
        if (sLength >= minLength) {
            var searchMatchCount = (1 << skipTrigger) + 3;

            // Consume until last n literals (Lz4 spec limitation.)
            while (sIndex + minMatch < sEnd - searchLimit) {
                var seq = util.readU32(src, sIndex);
                var hash = util.hashU32(seq) >>> 0;

                // Crush hash to 16 bits.
                hash = ((hash >> 16) ^ hash) >>> 0 & 0xffff;

                // Look for a match in the hashtable. NOTE: remove one; see below.
                mIndex = hashTable[hash] - 1;

                // Put pos in hash table. NOTE: add one so that zero = invalid.
                hashTable[hash] = sIndex + 1;

                // Determine if there is a match (within range.)
                if (mIndex < 0 || ((sIndex - mIndex) >>> 16) > 0 || util.readU32(src, mIndex) !== seq) {
                    mStep = searchMatchCount++ >> skipTrigger;
                    sIndex += mStep;
                    continue;
                }

                searchMatchCount = (1 << skipTrigger) + 3;

                // Calculate literal count and offset.
                literalCount = sIndex - mAnchor;
                mOffset = sIndex - mIndex;

                // We've already matched one word, so get that out of the way.
                sIndex += minMatch;
                mIndex += minMatch;

                // Determine match length.
                // N.B.: mLength does not include minMatch, Lz4 adds it back
                // in decoding.
                mLength = sIndex;
                while (sIndex < sEnd - searchLimit && src[sIndex] === src[mIndex]) {
                    sIndex++;
                    mIndex++;
                }
                mLength = sIndex - mLength;

                // Write token + literal count.
                var token = mLength < mlMask ? mLength : mlMask;
                if (literalCount >= runMask) {
                    dst[dIndex++] = (runMask << mlBits) + token;
                    for (n = literalCount - runMask; n >= 0xff; n -= 0xff) {
                        dst[dIndex++] = 0xff;
                    }
                    dst[dIndex++] = n;
                } else {
                    dst[dIndex++] = (literalCount << mlBits) + token;
                }

                // Write literals.
                for (var i = 0; i < literalCount; i++) {
                    dst[dIndex++] = src[mAnchor + i];
                }

                // Write offset.
                dst[dIndex++] = mOffset;
                dst[dIndex++] = (mOffset >> 8);

                // Write match length.
                if (mLength >= mlMask) {
                    for (n = mLength - mlMask; n >= 0xff; n -= 0xff) {
                        dst[dIndex++] = 0xff;
                    }
                    dst[dIndex++] = n;
                }

                // Move the anchor.
                mAnchor = sIndex;
            }
        }

        // Nothing was encoded.
        if (mAnchor === 0) {
            return 0;
        }

        // Write remaining literals.
        // Write literal token+count.
        literalCount = sEnd - mAnchor;
        if (literalCount >= runMask) {
            dst[dIndex++] = (runMask << mlBits);
            for (n = literalCount - runMask; n >= 0xff; n -= 0xff) {
                dst[dIndex++] = 0xff;
            }
            dst[dIndex++] = n;
        } else {
            dst[dIndex++] = (literalCount << mlBits);
        }

        // Write literals.
        sIndex = mAnchor;
        while (sIndex < sEnd) {
            dst[dIndex++] = src[sIndex++];
        }

        return dIndex;
    };

    // Decompresses a frame of Lz4 data.
    exports.decompressFrame = function decompressFrame (src, dst) {
        var useBlockSum, useContentSum, useContentSize, descriptor;
        var sIndex = 0;
        var dIndex = 0;

        // Read magic number
        if (util.readU32(src, sIndex) !== magicNum) {
            throw new Error('invalid magic number');
        }

        sIndex += 4;

        // Read descriptor
        descriptor = src[sIndex++];

        // Check version
        if ((descriptor & fdVersionMask) !== fdVersion) {
            throw new Error('incompatible descriptor version');
        }

        // Read flags
        useBlockSum = (descriptor & fdBlockChksum) !== 0;
        useContentSum = (descriptor & fdContentChksum) !== 0;
        useContentSize = (descriptor & fdContentSize) !== 0;

        // Read block size
        var bsIdx = (src[sIndex++] >> bsShift) & bsMask;

        if (bsMap[bsIdx] === undefined) {
            throw new Error('invalid block size');
        }

        if (useContentSize) {
            // TODO: read content size
            sIndex += 8;
        }

        sIndex++;

        // Read blocks.
        while (true) {
            var compSize;

            compSize = util.readU32(src, sIndex);
            sIndex += 4;

            if (compSize === 0) {
                break;
            }

            if (useBlockSum) {
                // TODO: read block checksum
                sIndex += 4;
            }

            // Check if block is compressed
            if ((compSize & bsUncompressed) !== 0) {
                // Mask off the 'uncompressed' bit
                compSize &= ~bsUncompressed;

                // Copy uncompressed data into destination buffer.
                for (var j = 0; j < compSize; j++) {
                    dst[dIndex++] = src[sIndex++];
                }
            } else {
                // Decompress into blockBuf
                dIndex = exports.decompressBlock(src, dst, sIndex, compSize, dIndex);
                sIndex += compSize;
            }
        }

        if (useContentSum) {
            // TODO: read content checksum
            sIndex += 4;
        }

        return dIndex;
    };

    // Compresses data to an Lz4 frame.
    exports.compressFrame = function compressFrame (src, dst) {
        var dIndex = 0;

        // Write magic number.
        util.writeU32(dst, dIndex, magicNum);
        dIndex += 4;

        // Descriptor flags.
        dst[dIndex++] = fdVersion;
        dst[dIndex++] = bsDefault << bsShift;

        // Descriptor checksum.
        dst[dIndex] = xxhash.hash(0, dst, 4, dIndex - 4) >> 8;
        dIndex++;

        // Write blocks.
        var maxBlockSize = bsMap[bsDefault];
        var remaining = src.length;
        var sIndex = 0;

        // Clear the hashtable.
        clearHashTable(hashTable);

        // Split input into blocks and write.
        while (remaining > 0) {
            var compSize = 0;
            var blockSize = remaining > maxBlockSize ? maxBlockSize : remaining;

            compSize = exports.compressBlock(src, blockBuf, sIndex, blockSize, hashTable);
            /*
              if (compSize > blockSize || compSize === 0) {
              // Output uncompressed.
              util.writeU32(dst, dIndex, 0x80000000 | blockSize);
              dIndex += 4;

              for (var z = sIndex + blockSize; sIndex < z;) {
              dst[dIndex++] = src[sIndex++];
              }

              remaining -= blockSize;
              } else {
            */
            // Output compressed.
            util.writeU32(dst, dIndex, compSize);
            dIndex += 4;

            for (var j = 0; j < compSize;) {
                dst[dIndex++] = blockBuf[j++];
            }

            sIndex += blockSize;
            remaining -= blockSize;
        }
        //  }

        // Write blank end block.
        util.writeU32(dst, dIndex, 0);
        dIndex += 4;

        return dIndex;
    };

    // Decompresses a buffer containing an Lz4 frame. maxSize is optional; if not
    // provided, a maximum size will be determined by examining the data. The
    // buffer returned will always be perfectly-sized.
    exports.decompress = function decompress (src, maxSize) {
        var dst, size;

        if (maxSize === undefined) {
            maxSize = exports.decompressBound(src);
        }
        dst = exports.makeBuffer(maxSize);
        size = exports.decompressFrame(src, dst);

        if (size !== maxSize) {
            dst = sliceArray(dst, 0, size);
        }

        return dst;
    };

    // Compresses a buffer to an Lz4 frame. maxSize is optional; if not provided,
    // a buffer will be created based on the theoretical worst output size for a
    // given input size. The buffer returned will always be perfectly-sized.
    exports.compress = function compress (src, maxSize) {
        var dst, size;

        if (maxSize === undefined) {
            maxSize = exports.compressBound(src.length);
        }

        dst = exports.makeBuffer(maxSize);
        size = exports.compressFrame(src, dst);

        if (size !== maxSize) {
            dst = sliceArray(dst, 0, size);
        }

        return dst;
    };
    

    return function(data){
        return exports.compress(data);
    };
})();

/// ----- AUDIO -----

var readAudio = (function(){
    let audioContext = new AudioContext();

    function downSample( data, bpp, rate, signed ){
        let ok, nok;
        let p = new Promise((_ok, _nok) => {
            ok = _ok;
            nok = _nok;
        });

        try{

            if( data.byteLength ){
                audioContext.decodeAudioData(data)
                    .then( buffer => {
                        return downSample(buffer, bpp, rate);
                    }).then( data => {
                        ok( data );
                    }).catch( nok );
                return p;
            }

            let ctx = new OfflineAudioContext( 1,
                                               rate * data.duration,
                                               rate
                                             );

            let src = ctx.createBufferSource();
            src.buffer = data;
            src.connect( ctx.destination );
            src.start();
            ctx.startRendering()
                .then(buffer=>ok( [...buffer.getChannelData(0)]
                                  .map( x => (signed?x*0.5 : x*0.5+0.5)*((~0) >>> (32 - bpp)) )
                                ))
                .catch(ex => nok(ex));
        }catch(ex){
            nok(ex);
        }

        return p;
    }
    
    return function(file, opts){
        let settings = Object.assign({}, opts);
        let bpp = settings.bpp || 8;
        let rate = settings.rate || 8000;
        let signed = settings.signed || false;
        return downSample(file, bpp, rate);
    };

})();
