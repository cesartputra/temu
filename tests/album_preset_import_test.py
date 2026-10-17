import importlib.util,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('preset_import',Path(__file__).resolve().parents[1]/'scripts/import_album_presets.py')
presets=importlib.util.module_from_spec(spec);spec.loader.exec_module(presets)

class PresetImportTests(unittest.TestCase):
 def test_identity_monochrome_and_tone_curves(self):
  curves=[[(0,0),(1,1)]]*4
  identity=presets.colour_transform({},curves)
  self.assertEqual(identity((.2,.6,1)),bytes([51,153,255]))
  mono=presets.colour_transform({'Saturation':'-100'},curves)((.8,.4,.1))
  self.assertEqual(mono[0],mono[1]);self.assertEqual(mono[1],mono[2])
  lift=presets.colour_transform({},[[(0,.1),(1,1)],*curves[1:]])
  self.assertGreater(lift((0,0,0))[0],identity((0,0,0))[0])
 def test_only_image_settings_are_imported_not_nested_look_settings(self):
  xml=b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0.5"><crs:Look><rdf:Description crs:Exposure2012="9"/></crs:Look></rdf:Description></rdf:RDF></x:xmpmeta>'
  with tempfile.TemporaryDirectory() as folder:
   file=Path(folder)/'Fuji1.dng';file.write_bytes(b'II TIFF placeholder'+xml)
   settings,curves=presets.read_settings(file);self.assertEqual(settings['Exposure2012'],'0.5');self.assertEqual(curves[0],[(0,0),(1,1)])
   file.write_bytes(b'not metadata');self.assertRaises(ValueError,presets.read_settings,file)
 def test_source_names_produce_stable_safe_ids_and_english_names(self):
  self.assertEqual(presets.identity(Path('Custom bnw night a.dng')),('lr-custom-bnw-night-a','B&W Night A','Black & White'))
  self.assertEqual(presets.identity(Path('G7X i.dng')),('lr-g7x-i','G7X I','Canon G7X'))
