"""Guest-scoped iCalendar feed for native calendar subscriptions."""
import re
from datetime import datetime,timezone,timedelta
WIB=timezone(timedelta(hours=7))
def times(raw,default):
    values=re.findall(r'(\d{1,2})[.:](\d{2})',raw or '')
    if len(values)<2:values=default
    return [tuple(map(int,value)) for value in values[:2]]
def calendar_feed(event,akad):
    day=datetime.strptime(event['date'],'%Y-%m-%d');w=event.get('wedding',{})
    def escape(value):return str(value or '').replace('\\','\\\\').replace('\r','').replace('\n','\\n').replace(';','\\;').replace(',','\\,')
    def stamp(value):return value.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    entries=[('resepsi','Resepsi',w.get('receptionTime'),[(18,30),(20,30)])]
    if akad:entries.insert(0,('akad','Akad',w.get('ceremonyTime'),[(15,30),(17,0)]))
    lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Temu//Wedding//ID','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:#foREVArwithCESAR']
    for kind,title,raw,default in entries:
        start,end=times(raw,default)
        begin=day.replace(hour=start[0],minute=start[1],tzinfo=WIB);finish=day.replace(hour=end[0],minute=end[1],tzinfo=WIB)
        lines+=['BEGIN:VEVENT','UID:'+kind+'-'+event['date']+'@forevarwithcesar.helipod.app','DTSTAMP:'+stamp(datetime.now(timezone.utc)),'DTSTART:'+stamp(begin),'DTEND:'+stamp(finish),'SUMMARY:'+escape(title+' Reva & Cesar'),'LOCATION:'+escape(' · '.join(filter(None,[w.get('venue'),w.get('address')]))),'DESCRIPTION:'+escape('#foREVArwithCESAR\n'+w.get('mapsURL','')),'END:VEVENT']
    lines+=['END:VCALENDAR'];folded=[]
    for line in lines:
        part=''
        for char in line:
            if len((part+char).encode())>75:folded.append(part);part=' '
            part+=char
        folded.append(part)
    return '\r\n'.join(folded)+'\r\n'
