import json, tempfile, threading, unittest, urllib.request, urllib.error
from server_test import server, seed, bootstrap, change

class PersonalInvitationTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=server.Database(self.tmp.name);self.state=seed();self.state['guests'][0]['quota']=2
  self.db.sync({'event':'wedding','operations':[bootstrap(self.state)]})
  self.token='t'*40;self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,self.token,{'127.0.0.1'}))
  self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.http.server_port}'
 def tearDown(self):self.http.shutdown();self.http.server_close();self.thread.join();self.tmp.cleanup()
 def post(self,path,data,admin=False):
  headers={'Content-Type':'application/json','X-Temu-Invite':'1'}
  if admin:headers['Authorization']='Bearer '+self.token
  req=urllib.request.Request(self.origin+path,data=json.dumps(data).encode(),headers=headers)
  with urllib.request.urlopen(req) as response:return json.load(response)
 def test_unique_link_rsvp_wish_and_overview(self):
  link=self.post('/api/invite/admin/link',{'event':'wedding','guest':'g'},True)
  self.assertEqual(len(link['key']),43);self.assertEqual(link,self.post('/api/invite/admin/link',{'event':'wedding','guest':'g'},True))
  guest=self.post('/api/invite/guest',link);self.assertEqual(guest['guest'],{'name':'Tamu Uji','quota':2});self.assertIsNone(guest['rsvp'])
  with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/rsvp',{**link,'status':'attending','count':3})
  self.assertEqual(failure.exception.code,400);failure.exception.close()
  self.post('/api/invite/rsvp',{**link,'status':'attending','count':2})
  overview=json.load(urllib.request.urlopen(urllib.request.Request(self.origin+'/api/invite/admin/rsvp',headers={'Authorization':'Bearer '+self.token})))
  self.assertEqual(overview['summary'],{'attending':1,'declined':0,'pending':0,'persons':2})
  self.post('/api/invite/wish',{**link,'message':'Semoga bahagia <selalu>'})
  with urllib.request.urlopen(self.origin+'/api/invite/wishes') as response:wishes=json.load(response)['wishes']
  self.assertEqual(wishes[0]['message'],'Semoga bahagia <selalu>')
  self.post('/api/invite/rsvp',{**link,'status':'declined','count':0})
  self.assertEqual(self.db.rsvp_overview('wedding')['summary']['declined'],1)
  restarted=server.Database(self.tmp.name)
  self.assertEqual(restarted.guest_link('wedding','g'),link)
  self.assertEqual(restarted.invite_guest(**link)['rsvp']['status'],'declined')
  self.assertEqual(restarted.public_wishes()[0]['message'],'Semoga bahagia <selalu>')
  self.db.backup(force=True);self.assertTrue(list(self.db.backup_dir.glob('*.sqlite3')))
 def test_invalid_link_and_deleted_guest_cannot_submit(self):
  link=self.db.guest_link('wedding','g')
  with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/guest',{**link,'key':'A'*43})
  self.assertEqual(failure.exception.code,400);failure.exception.close()
  op=change(self.state,0);op['changes'][0]['after']['active']=False;self.db.sync({'event':'wedding','operations':[op]})
  with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/guest',link)
  self.assertEqual(failure.exception.code,400);failure.exception.close()
  self.assertEqual(self.db.public_wishes(),[])

if __name__=='__main__':unittest.main()
