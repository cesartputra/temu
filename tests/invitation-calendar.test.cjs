const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../dist/invitation2-calendar.js');
test('calendar contains separate ceremony and reception at the correct WIB times',()=>{
 const content=create({date:'2026-11-21',now:new Date('2026-10-02T00:00:00Z')});
 assert.equal((content.match(/BEGIN:VEVENT/g)||[]).length,2);
 for(const value of ['DTSTART:20261121T083000Z','DTEND:20261121T100000Z','DTSTART:20261121T113000Z','DTEND:20261121T133000Z','SUMMARY:Akad Reva & Cesar','SUMMARY:Resepsi Reva & Cesar'])assert.ok(content.includes(value));
 assert.equal((content.match(/UID:/g)||[]).length,2);assert.ok(content.endsWith('END:VCALENDAR\r\n'));
});
test('calendar text escapes newlines and folds long Unicode lines without splitting characters',()=>{
 const content=create({date:'2026-11-21',location:'Tempat, acara;\\\nBEGIN:VEVENT'+ ' ♡'.repeat(50)});
 assert.equal((content.match(/\r\nBEGIN:VEVENT/g)||[]).length,2);
 assert.ok(content.includes('Tempat\\, acara\\;\\\\\\nBEGIN:VEVENT'));
 for(const line of content.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
 assert.ok(!content.includes('�'));
});
test('calendar rejects missing dates',()=>{assert.throws(()=>create({date:''}),/Tanggal/);});
