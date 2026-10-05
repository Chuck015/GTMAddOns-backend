-- How the inventory opened for each swap (migration 0017), recorded by the mod so admin Player info can flag cursor tricks:
-- cursor_dx/dy = cursor offset from the window centre in raw window pixels (0, 0 in vanilla when opened from gameplay),
-- direct_px/approach_px = straight and travelled cursor distance to the slot (pixels, independent of mouse sensitivity),
-- gui_x/gui_y/scaled_w/scaled_h/gui_scale = where the inventory was drawn (the recipe book moves it sideways),
-- creative = 1 for the creative inventory, from_screen = 1 when it replaced another screen (cursor not reset then).
ALTER TABLE swaps ADD COLUMN cursor_dx REAL;
ALTER TABLE swaps ADD COLUMN cursor_dy REAL;
ALTER TABLE swaps ADD COLUMN direct_px REAL;
ALTER TABLE swaps ADD COLUMN approach_px REAL;
ALTER TABLE swaps ADD COLUMN gui_x REAL;
ALTER TABLE swaps ADD COLUMN gui_y REAL;
ALTER TABLE swaps ADD COLUMN scaled_w REAL;
ALTER TABLE swaps ADD COLUMN scaled_h REAL;
ALTER TABLE swaps ADD COLUMN gui_scale REAL;
ALTER TABLE swaps ADD COLUMN creative REAL;
ALTER TABLE swaps ADD COLUMN from_screen REAL;
