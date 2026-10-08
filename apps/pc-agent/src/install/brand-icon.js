// Multi-resolution 32-bit ICO, generated deterministically without build-time tools.
export function createJarvisBrandIcon() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => {
    const maskStride = Math.ceil(size / 32) * 4;
    const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    dib.writeUInt32LE(40, 0); dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
    dib.writeUInt32LE(size * size * 4, 20);
    const distanceToSegment = (x, y, ax, ay, bx, by) => {
      const t = Math.max(0, Math.min(1, ((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));
      return Math.hypot(x-ax-t*(bx-ax), y-ay-t*(by-ay));
    };
    for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
      let coverage=0;
      for (let sy=0; sy<4; sy++) for (let sx=0; sx<4; sx++) {
        const px=(x+(sx+.5)/4)/size, py=(y+(sy+.5)/4)/size;
        const ring=Math.abs(Math.hypot(px-.5,py-.5)-.395)<.048;
        const stem=distanceToSegment(px,py,.61,.26,.61,.59)<.048;
        const hook=Math.abs(Math.hypot(px-.47,py-.59)-.14)<.048 && py>=.59;
        if (ring || stem || hook) coverage++;
      }
      const at=40+((size-1-y)*size+x)*4;
      dib[at]=123; dib[at+1]=141; dib[at+2]=18; dib[at+3]=Math.round(coverage*255/16);
      if (!coverage) dib[40+size*size*4+(size-1-y)*maskStride+(x>>3)] |= 0x80>>(x%8);
    }
    return dib;
  });
  const header=Buffer.alloc(6+16*sizes.length); header.writeUInt16LE(1,2); header.writeUInt16LE(sizes.length,4);
  let offset=header.length;
  images.forEach((image,i)=>{const at=6+16*i; header[at]=sizes[i]%256;header[at+1]=sizes[i]%256;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(image.length,at+8);header.writeUInt32LE(offset,at+12);offset+=image.length;});
  return Buffer.concat([header,...images]);
}
