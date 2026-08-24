"""ieee_style.py — figure conventions for IEEE J-BHI submissions.

Applied by make_figure3/4/5.py so every panel in the manuscript looks like a journal
figure rather than a slide: Times New Roman to match the body text, 8 pt labels,
thin black rules, inward ticks, no coloured panel backgrounds, no in-figure titles
(the caption carries them), and a grayscale-safe palette in which every series is
also distinguishable by line style and marker.

IEEE column widths: 3.5 in single column, 7.16 in double column (the manuscript
places all four figures in page-wide one-column sections, so use WIDE or less).
"""
import matplotlib

SINGLE, WIDE = 3.5, 7.16          # inches
# Grayscale-safe: distinct lightness steps, each series also has its own dash/marker.
INK = "#000000"
GRAY = "#6e6e6e"
LIGHT = "#b8b8b8"
SERIES = ["#000000", "#5b5b5b", "#8f8f8f"]        # primary, secondary, tertiary
ACCENT = "#1a4f8a"                                 # used sparingly, prints dark in gray
BAND = ["#fafafa", "#f0f0f0", "#e6e6e6"]           # guidance bands, light → dark

# White halo for text that must sit on top of a rule or a marker cluster. Journal
# figures label the feature they describe rather than moving the label away from it;
# the halo keeps the glyphs readable without hiding where the label points.
HALO = dict(facecolor="white", edgecolor="none", pad=1.2)

RC = {
    "font.family": "serif",
    "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 8,
    "axes.labelsize": 8, "axes.titlesize": 8,
    "xtick.labelsize": 7.5, "ytick.labelsize": 7.5,
    "legend.fontsize": 7.5,
    "axes.linewidth": 0.6, "axes.edgecolor": INK,
    "axes.grid": False,
    "axes.spines.top": False, "axes.spines.right": False,
    "xtick.direction": "in", "ytick.direction": "in",
    "xtick.major.width": 0.6, "ytick.major.width": 0.6,
    "xtick.major.size": 2.5, "ytick.major.size": 2.5,
    "lines.linewidth": 1.0, "lines.markersize": 3.0,
    "legend.frameon": False, "legend.handlelength": 2.4, "legend.borderaxespad": 0.3,
    "figure.dpi": 150, "savefig.dpi": 300, "savefig.bbox": "tight",
    "savefig.pad_inches": 0.02,
    "pdf.fonttype": 42, "ps.fonttype": 42,          # embed real fonts, not Type 3
}


def apply():
    """Install the journal style hermetically.

    The manuscript figures must come out the same whether a script is run from a
    shell or from inside the analysis notebook. The notebook configures its own
    rcParams first, and anything this module does not name would otherwise leak
    into the submission figures, so reset to matplotlib's defaults before
    applying RC. The backend is preserved: callers already pinned Agg.
    """
    backend = matplotlib.get_backend()
    matplotlib.rcdefaults()
    matplotlib.rcParams["backend"] = backend
    matplotlib.rcParams.update(RC)


def panel_label(ax, text, x=-0.13, y=1.04):
    """IEEE panel tag, e.g. '(a)', placed outside the axes at upper left."""
    ax.text(x, y, text, transform=ax.transAxes, fontsize=8, va="bottom", ha="left")
