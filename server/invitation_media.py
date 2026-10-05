"""Fixed private media inventory. Photographs themselves never enter Git."""
GALLERY = (
    ('portrait-2.jpg', 'SPW07365'),
    ('portrait-3.jpg', 'SPW07399'),
    ('portrait-1.jpg', 'SPW07341'),
    ('gallery-SPW07375.jpg', 'SPW07375'),
    ('gallery-SPW07379.jpg', 'SPW07379'),
    ('gallery-SPW07355.jpg', 'SPW07355'),
    ('gallery-SPW07360.jpg', 'SPW07360'),
    ('gallery-SPW07228.jpg', 'SPW07228'),
    ('gallery-SPW07251.jpg', 'SPW07251'),
    ('gallery-SPW07286.jpg', 'SPW07286'),
    ('gallery-SPW07327.jpg', 'SPW07327'),
    ('gallery-SPW07314.jpg', 'SPW07314'),
    ('gallery-SPW07281.jpg', 'SPW07281'),
    ('gallery-SPW07337.jpg', 'SPW07337'),
    ('gallery-SPW07268.jpg', 'SPW07268'),
)
MEDIA_NAMES = tuple(name for name, _ in GALLERY) + ('portrait-cesar.jpg', 'portrait-revalina.jpg', 'film.mp4', 'song.mp3')
