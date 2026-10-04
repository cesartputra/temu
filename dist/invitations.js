/* WhatsApp drafts and native file sharing; never sends a message automatically. */
(function(root){
'use strict';
const defaultTemplate='Yth. {nama},\n\nDengan bahagia kami mengundang Anda untuk hadir di {acara} pada {tanggal}.\nUndangan ini berlaku untuk {jumlah} orang.\n\nMohon tunjukkan QR terlampir saat tiba. Kehadiran Anda akan melengkapi kebahagiaan kami.\n\nTerima kasih.';
function normalizePhone(value){
 const input=String(value??'').trim();if(!input)return '';
 if(!/^[+\d\s().-]+$/.test(input)||input.slice(1).includes('+'))throw Error('Nomor WhatsApp hanya boleh berisi angka dan kode negara.');
 let phone=input.replace(/[\s().-]/g,'').replace(/^\+/,'');
 if(phone.startsWith('00'))phone=phone.slice(2);
 if(phone.startsWith('08'))phone='62'+phone.slice(1);
 if(!/^[1-9]\d{7,14}$/.test(phone))throw Error('Gunakan nomor 08… atau format internasional, misalnya +62… (8–15 digit).');
 return phone;
}
function message(guest,event){
 const date=event.date?new Date(event.date+'T12:00:00').toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'}):'(tanggal menyusul)';
 const fields={nama:guest.name,acara:String(event.name||'').replaceAll('Cesar & Revalina','Reva & Cesar').replaceAll('Cesar dan Revalina','Reva dan Cesar'),tanggal:date,jumlah:String(guest.quota)};
 return (event.invitationText||defaultTemplate).replace(/\{(nama|acara|tanggal|jumlah)\}/g,(_,key)=>fields[key]);
}
function whatsappURL(phone,text){const normalized=normalizePhone(phone);if(!normalized)throw Error('Simpan nomor WhatsApp tamu terlebih dahulu.');return 'https://wa.me/'+normalized+'?text='+encodeURIComponent(text);}
function qrFile(guest,event){return new Promise((resolve,reject)=>{
 try{const qr=qrcode(0,'M');qr.addData(JSON.stringify({v:1,event:event.id,code:guest.code}));qr.make();const count=qr.getModuleCount(),quiet=4,scale=12,canvas=document.createElement('canvas');canvas.width=canvas.height=(count+quiet*2)*scale;const ctx=canvas.getContext('2d');if(!ctx)throw Error('Gambar QR tidak dapat disiapkan.');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000000';for(let y=0;y<count;y++)for(let x=0;x<count;x++)if(qr.isDark(y,x))ctx.fillRect((x+quiet)*scale,(y+quiet)*scale,scale,scale);canvas.toBlob(blob=>blob?resolve(new File([blob],'undangan-'+guest.code+'.png',{type:'image/png'})):reject(Error('Gambar QR tidak dapat dibuat.')),'image/png');}catch(e){reject(e);}
});}
async function copyQR(file,text=null){
 if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw Error('Browser belum mendukung salin gambar. Gunakan Unduh QR PNG dan Salin teks saja.');
 const data={'image/png':file};
 if(text!==null)data['text/plain']=new Blob([text],{type:'text/plain'});
 await navigator.clipboard.write([new ClipboardItem(data)]);
}
root.TemuInvitations={defaultTemplate,normalizePhone,message,whatsappURL,qrFile,copyQR};
if(typeof module!=='undefined')module.exports=root.TemuInvitations;
})(globalThis);
