// Minimal PNG reader for 8-bit RGBA non-interlaced (what all our assets are)
const zlib=require('zlib'), fs=require('fs');
function readPng(file){
  const d=fs.readFileSync(file);
  if(d.readUInt32BE(0)!==0x89504e47) throw new Error('not png');
  let off=8, w=0,h=0,depth=0,ctype=0, idat=[];
  while(off<d.length){
    const len=d.readUInt32BE(off), type=d.toString('ascii',off+4,off+8), data=d.subarray(off+8,off+8+len);
    if(type==='IHDR'){ w=data.readUInt32BE(0); h=data.readUInt32BE(4); depth=data[8]; ctype=data[9];
      if(data[12]!==0) throw new Error('interlaced not supported'); }
    else if(type==='IDAT') idat.push(data);
    else if(type==='IEND') break;
    off+=12+len;
  }
  if(depth!==8||ctype!==6) throw new Error(`need 8-bit RGBA, got depth=${depth} color=${ctype}`);
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const bpp=4, stride=w*bpp, out=Buffer.alloc(h*stride);
  let p=0;
  for(let y=0;y<h;y++){
    const f=raw[p++]; const line=raw.subarray(p,p+stride); p+=stride;
    const cur=out.subarray(y*stride,(y+1)*stride), prev=y?out.subarray((y-1)*stride,y*stride):null;
    for(let x=0;x<stride;x++){
      const a=x>=bpp?cur[x-bpp]:0, b=prev?prev[x]:0, c=(x>=bpp&&prev)?prev[x-bpp]:0; let v=line[x];
      if(f===1)v+=a; else if(f===2)v+=b; else if(f===3)v+=(a+b)>>1;
      else if(f===4){const pa=Math.abs(b-c),pb=Math.abs(a-c),pc=Math.abs(a+b-2*c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c);}
      cur[x]=v&255;
    }
  }
  return {w,h,data:out};
}
module.exports={readPng};

// ---- writer: 8-bit RGBA, filter 0 ----
const CRC=(()=>{const t=[...Array(256)].map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  return b=>{let c=0xffffffff;for(const x of b)c=t[(c^x)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};})();
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);
  const td=Buffer.concat([Buffer.from(type),data]);const cb=Buffer.alloc(4);cb.writeUInt32BE(CRC(td));
  return Buffer.concat([len,td,cb]);}
function writePng(w,h,rgba){
  const stride=w*4, rows=Buffer.alloc(h*(stride+1));
  for(let y=0;y<h;y++){ rows[y*(stride+1)]=0; rgba.copy(rows,y*(stride+1)+1,y*stride,(y+1)*stride); }
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr),
    chunk('IDAT', zlib.deflateSync(rows,{level:9})), chunk('IEND',Buffer.alloc(0))]);
}
function cropAlpha(img,thresh=8){
  let x0=img.w,y0=img.h,x1=-1,y1=-1;
  for(let y=0;y<img.h;y++)for(let x=0;x<img.w;x++){
    if(img.data[(y*img.w+x)*4+3]>thresh){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; } }
  const w=x1-x0+1,h=y1-y0+1,out=Buffer.alloc(w*h*4);
  for(let y=0;y<h;y++) img.data.copy(out,y*w*4,((y+y0)*img.w+x0)*4,((y+y0)*img.w+x0+w)*4);
  return {w,h,data:out};
}
function resize(img,W,H){
  const out=Buffer.alloc(W*H*4);
  for(let y=0;y<H;y++){
    const sy0=Math.floor(y*img.h/H), sy1=Math.max(sy0+1,Math.floor((y+1)*img.h/H));
    for(let x=0;x<W;x++){
      const sx0=Math.floor(x*img.w/W), sx1=Math.max(sx0+1,Math.floor((x+1)*img.w/W));
      let r=0,g=0,b=0,a=0,n=0;
      for(let sy=sy0;sy<sy1;sy++)for(let sx=sx0;sx<sx1;sx++){
        const i=(sy*img.w+sx)*4, al=img.data[i+3]/255;
        r+=img.data[i]*al; g+=img.data[i+1]*al; b+=img.data[i+2]*al; a+=img.data[i+3]; n++;
      }
      const o=(y*W+x)*4, A=a/n;
      out[o]=A?Math.round(r/n/(A/255)):0; out[o+1]=A?Math.round(g/n/(A/255)):0;
      out[o+2]=A?Math.round(b/n/(A/255)):0; out[o+3]=Math.round(A);
    }
  }
  return {w:W,h:H,data:out};
}
function solid(w,h,[r,g,b]){ const d=Buffer.alloc(w*h*4);
  for(let i=0;i<w*h;i++){ d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=255; } return {w,h,data:d}; }
function compose(dst,src,dx,dy){
  for(let y=0;y<src.h;y++){ const ty=dy+y; if(ty<0||ty>=dst.h) continue;
    for(let x=0;x<src.w;x++){ const tx=dx+x; if(tx<0||tx>=dst.w) continue;
      const s=(y*src.w+x)*4, t=(ty*dst.w+tx)*4, a=src.data[s+3]/255; if(!a) continue;
      for(let k=0;k<3;k++) dst.data[t+k]=Math.round(src.data[s+k]*a+dst.data[t+k]*(1-a));
      dst.data[t+3]=255; } }
}
module.exports={readPng,writePng,cropAlpha,resize,solid,compose};
