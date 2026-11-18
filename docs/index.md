# Overview

[➡ Go to User Guide](users/user_guide.md)

Trace is a web application for plotting live and archived EPICS process variables (PVs) at SLAC. It is the browser version of Trace, the PyDM-based plotting tool, and it can open that tool's `.trc` files. Trace shows current values as they change and fills in history from the archiver, so you can compare signals over any time range without installing anything.

This guide is intended for:

- Operators, physicists, and engineers who need to plot, compare, and share PV data.

## Opening Trace

Open Trace in a web browser. No installation is needed.

Trace remembers your light/dark mode and color palette choices in the browser. To keep a set of plots, save it as a workspace (see [Save and Open Workspaces](users/user_guide.md#save-and-open-workspaces)).

## Support and Contact Information

### Feedback/Issue Reporting

Users can submit feedback or report issues by clicking the bug icon in Trace's header.

Please include as much detail as possible, such as:

- Steps to reproduce the issue
- Screenshots or attachments
- The PVs and time range involved
- Browser or system information

Attaching a saved workspace (`.trc.json`) helps the team see exactly what you were looking at.

## Glossary

- PV (process variable): A named value in the EPICS control system, such as `TEST:SINE`.
- Trace: A line on a plot that follows one PV, or a formula.
- Axis: A vertical scale on a plot. Each trace belongs to one axis.
- Archiver: The service that stores PV history.
- Live data: Values streamed from the control system as they change.
- Binned data: Averaged archive data, with minimum and maximum, used for time ranges longer than 30 minutes.
- Formula curve: A trace calculated from other traces.
- Workspace: A saved file (`.trc.json`) with your plots, axes, traces, and settings.
