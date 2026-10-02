'use strict';
(function(root){
 const escape=value=>String(value||'').replace(/\\/g,'\\\\').replace(/\r?\n|\r/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
 function fold(line){let result='',width=0;for(const char of line){const size=new TextEncoder().encode(char).length;if(width+size>75){result+='\r\n ';width=1;}result+=char;width+=size;}return result;}
 const stamp=date=>date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
 function create({date,location='Steikhaus Bandung',address='Bandung, Jawa Barat',mapsURL='',now=new Date()}){
  const day=String(date).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(day+'T00:00:00+07:00')))throw Error('Tanggal acara belum tersedia.');
  const entries=[['akad','Akad Reva & Cesar','15:30','17:00'],['resepsi','Resepsi Reva & Cesar','18:30','20:30']];
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Reva Cesar//Wedding Invitation//ID','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  for(const [id,title,start,end] of entries){lines.push('BEGIN:VEVENT','UID:'+id+'-'+day+'@forevarwithcesar.helipod.app','DTSTAMP:'+stamp(now),'DTSTART:'+stamp(new Date(day+'T'+start+':00+07:00')),'DTEND:'+stamp(new Date(day+'T'+end+':00+07:00')),'SUMMARY:'+escape(title),'LOCATION:'+escape([location,address].filter(Boolean).join(', ')),'DESCRIPTION:'+escape('#foREVArwithCESAR\n'+(mapsURL?'Lokasi: '+mapsURL:'')),'STATUS:CONFIRMED','END:VEVENT');}
  lines.push('END:VCALENDAR');return lines.map(fold).join('\r\n')+'\r\n';
 }
 const api={create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.TemuInviteCalendar=api;
})(typeof window!=='undefined'?window:globalThis);
