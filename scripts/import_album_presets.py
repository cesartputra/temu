"""Adapt DNG colour settings into small browser LUTs; never publish source photos."""
import argparse, colorsys, hashlib, json, math, re, unicodedata
from pathlib import Path
from xml.etree import ElementTree as ET

CRS = '{http://ns.adobe.com/camera-raw-settings/1.0/}'
COLORS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta']
HUES = [0, 30, 60, 120, 180, 240, 270, 300, 360]
SIZE = 17

def clamp(value, low=0, high=1):
    return max(low, min(high, value))

def interpolate(points, value):
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if value <= x1:
            return y0 + (y1-y0)*clamp((value-x0)/(x1-x0))
    return points[-1][1]

def read_settings(path):
    data = path.read_bytes()
    start = data.find(b'<x:xmpmeta')
    end = data.find(b'</x:xmpmeta>', start)
    if start < 0 or end < 0:
        raise ValueError(f'No Camera Raw metadata: {path.name}')
    root = ET.fromstring(data[start:end+12])
    # Only the top-level image settings, not nested look/preset descriptions.
    description = root.find('./{*}RDF/{*}Description')
    if description is None or CRS+'Exposure2012' not in description.attrib:
        raise ValueError(f'No image adjustment settings: {path.name}')
    settings = {key[len(CRS):]: value for key, value in description.attrib.items() if key.startswith(CRS)}
    curves = []
    for suffix in ['', 'Red', 'Green', 'Blue']:
        element = description.find(CRS+'ToneCurvePV2012'+suffix)
        points = [tuple(float(v)/255 for v in li.text.split(',')) for li in element.findall('.//{*}li')] if element is not None else [(0, 0), (1, 1)]
        if len(points) < 2 or any(b[0] <= a[0] for a, b in zip(points, points[1:])):
            raise ValueError(f'Invalid tone curve: {path.name}')
        curves.append(points)
    return settings, curves

def colour_transform(settings, curves):
    number = lambda name: float(settings.get(name, 0))
    exposure = 2**clamp(number('Exposure2012'), -5, 5)
    temperature = number('IncrementalTemperature')
    if not temperature and settings.get('WhiteBalance') == 'Custom' and settings.get('Temperature'):
        temperature = clamp((number('Temperature')-5500)/55, -100, 100)
    tint = number('IncrementalTint') or number('Tint')
    balance = [2**(temperature*.0025+tint*.0006), 2**(-tint*.0012), 2**(-temperature*.0025+tint*.0006)]
    contrast = 1+number('Contrast2012')*.007+number('Clarity2012')*.0015+number('Dehaze')*.002
    saturation = max(0, 1+number('Saturation')/100)
    vibrance = number('Vibrance')/100
    hue = [number('HueAdjustment'+c) for c in COLORS]
    sat = [number('SaturationAdjustment'+c) for c in COLORS]
    light = [number('LuminanceAdjustment'+c) for c in COLORS]
    shadow, highlight = number('Shadows2012')/100, number('Highlights2012')/100
    blacks, whites = number('Blacks2012')/100, number('Whites2012')/100
    parametric = [number('Parametric'+name)/100 for name in ['Shadows', 'Darks', 'Lights', 'Highlights']]
    tones = []
    for prefix, sat_key, hue_key in [('SplitToningShadow', 'Saturation', 'Hue'), ('ColorGradeMidtone', 'Sat', 'Hue'), ('SplitToningHighlight', 'Saturation', 'Hue'), ('ColorGradeGlobal', 'Sat', 'Hue')]:
        rgb = colorsys.hls_to_rgb(number(prefix+hue_key)/360, .5, 1)
        luminosity = sum(a*b for a, b in zip(rgb, [.2126, .7152, .0722]))
        tones.append(([v-luminosity for v in rgb], number(prefix+sat_key)/100))
    calibration = [number(c+'Hue') for c in ['Red', 'Green', 'Blue']]

    def transform(rgb):
        # Browser adaptation on developed sRGB, not Adobe's proprietary RAW engine.
        values = []
        for value, gain in zip(rgb, balance):
            linear = value/12.92 if value <= .04045 else ((value+.055)/1.055)**2.4
            linear *= exposure
            values.append(clamp((12.92*linear if linear <= .0031308 else 1.055*linear**(1/2.4)-.055)*gain))
        lum = sum(a*b for a, b in zip(values, [.2126, .7152, .0722]))
        lift = shadow*(1-lum)**2*lum*.65 + highlight*lum**2*(1-lum)*.65 + blacks*(1-lum)**4*.14 + whites*lum**4*.14
        lift += sum(amount*.08*math.exp(-((lum-center)/.23)**2) for amount, center in zip(parametric, [.1, .35, .65, .9]))
        values = [clamp((v-.5)*contrast+.5+lift) for v in values]
        h, l, s = colorsys.rgb_to_hls(*values)
        degrees = h*360
        band = next(i for i in range(8) if degrees <= HUES[i+1])
        weight = (degrees-HUES[band])/(HUES[band+1]-HUES[band])
        blend = lambda entries: entries[band]*(1-weight)+entries[(band+1)%8]*weight
        calibration_shift = sum(amount*max(0, 1-abs((degrees-center+180)%360-180)/120)*.12 for amount, center in zip(calibration, [0, 120, 240]))
        h = (h+(blend(hue)*.3+calibration_shift)/360)%1
        s = clamp(s*saturation*(1+vibrance*(1-s)*.6)*(1+blend(sat)/100))
        l = clamp(l+blend(light)/100*.22*s)
        values = list(colorsys.hls_to_rgb(h, l, s))
        values = [interpolate(curves[channel+1], interpolate(curves[0], v)) for channel, v in enumerate(values)]
        lum = sum(a*b for a, b in zip(values, [.2126, .7152, .0722]))
        for (colour, amount), weight in zip(tones, [(1-lum)**2, 4*lum*(1-lum), lum**2, 1]):
            values = [v+c*amount*weight*.28 for v, c in zip(values, colour)]
        if settings.get('ConvertToGrayscale') == 'True' or saturation == 0:
            grey = sum(a*b for a, b in zip(values, [.2126, .7152, .0722]))
            values = [grey]*3
        return bytes(round(clamp(v)*255) for v in values)
    return transform

def identity(path):
    stem = path.stem.strip()
    identifier = 'lr-'+re.sub(r'[^a-z0-9]+', '-', unicodedata.normalize('NFKD', stem).encode('ascii', 'ignore').decode().lower()).strip('-')
    lower = stem.lower()
    if lower.startswith('dazz'):
        family = 'Dazz'; name = re.sub(r'^dazzcam new\s*(\d)', r'Dazz Cam New \1', stem, flags=re.I)
        name = re.sub(r'^dazz(\d)', r'Dazz \1', name, flags=re.I)
    elif lower.startswith('fuji'):
        family = 'Fuji'; name = re.sub(r'^fuji(\d)', r'Fuji \1', stem, flags=re.I).title()
    elif lower.startswith('kodak'):
        family = 'Kodak'; name = re.sub(r'^kodak(\d)', r'Kodak \1', stem, flags=re.I)
    elif lower.startswith('g7x'):
        family = 'Canon G7X'; name = stem.replace('G7X-', 'G7X ').replace(' - ', ' ').title().replace('G7X', 'G7X')
    elif lower.startswith('custom bnw'):
        family = 'Black & White'; name = re.sub('custom bnw', 'B&W', stem, flags=re.I).title()
    elif lower.startswith('black'):
        family = 'Black'; name = stem.replace(' - ', ' ').title()
    elif lower.startswith('ds'):
        family = 'Selfie'; name = re.sub(r'^ds\s*', '', stem, flags=re.I).title()
    elif lower.startswith('light'):
        family = 'Light'; name = stem.title()
    else:
        family = 'Ricoh'; name = stem.title().replace('Gr ', 'GR ').replace('Foresttt', 'Forest').replace('Jog', 'Jogging').replace('Sashfir Savana', 'Savana')
    name = re.sub(r'\b(i{1,3}|iv|vi{0,3}|ix)\b', lambda m: m[0].upper(), name, flags=re.I)
    return identifier, name, family

def generate(folder, output):
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for path in sorted(folder.glob('*.dng'), key=lambda p: p.name.lower()):
        settings, curves = read_settings(path)
        identifier, name, family = identity(path)
        if any(row['id'] == identifier for row in records):
            raise ValueError(f'Duplicate ID: {path.name}')
        transform = colour_transform(settings, curves)
        lut = b''.join(transform((r/(SIZE-1), g/(SIZE-1), b/(SIZE-1))) for b in range(SIZE) for g in range(SIZE) for r in range(SIZE))
        filename = identifier+'-'+hashlib.sha256(lut).hexdigest()[:10]+'.lut'
        (output/filename).write_bytes(lut)
        records.append({'id':identifier, 'name':name, 'family':family, 'lut':filename, 'grain':float(settings.get('GrainAmount', 0)), 'vignette':float(settings.get('PostCropVignetteAmount', 0)), 'swatch':['#'+transform(rgb).hex() for rgb in [(.8,.6,.45),(.45,.55,.38)]]})
    if not records:
        raise ValueError('No DNG presets found')
    (output/'catalog.json').write_text(json.dumps({'size':SIZE, 'presets':records}, separators=(',', ':'))+'\n')
    print(f'Imported {len(records)} presets, {sum(p.stat().st_size for p in output.iterdir())//1024} KiB. Source images are not included.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1]/'dist/album-presets')
    arguments = parser.parse_args()
    generate(arguments.folder, arguments.output)
