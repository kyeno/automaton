# Local daylight learning

Daylight collection archives actual illuminance reports and human sky observations
in the existing SQLite database (`var/db/automaton.db`, or `DB_PATH`). It runs
independently of Weatherman announcements, AI, quiet hours and `sensor_history.enabled`.
Restart Automaton after configuring it. Collection cannot recover past reports.

Enable `daylight.recording_enabled` in `etc/automaton.yaml` and configure a sensor
list using the example in `etc/automaton.yaml.dist`. The shipped template defaults
to disabled. To stop collection, set the flag to false; existing evidence remains.
Labels are refused while disabled, but status, undo and export remain available.

`daylight.announcements_enabled: false` independently controls Weatherman's use
of sky estimates. It defaults to false and is disabled locally. Enabled consumers
still omit unknown, missing-model, failed or stale estimates. The classifier is
not implemented yet: setting this flag to true today cannot produce a sky report.
Recording can be disabled independently once a future trained model is available.

Use one command when you look outside:

- `/weather sunny`: mostly clear sky.
- `/weather cloudy`: partial or mixed cloud cover.
- `/weather overcast`: continuous cloud cover.
- `/weather unsure`: ambiguous observation, excluded from future hard labels.

Aliases: `clear`, `partly-cloudy`, `clouded`. These describe the visible sky,
not direct sunlight on the sensor. `/weather undo` undoes the latest active
observation, retaining the original event and an undo event for audit. Different
labels always create separate point observations. An identical label within five
minutes of the latest active label, with identical installation/location context,
is ignored. After five minutes it is a new observation. Future fitting must group
by time/day so repeated observations do not dominate the model.

`/weather status` shows recording state, active label count and latest report ages
within the 15-minute evidence window. The quality field describes the report value;
compare its age with `max_age_seconds` for freshness. A prediction is currently
always unknown: the collector does not fit a model. Weatherman has a gated
consumer for future qualified estimates on direct, AI and fallback paths.

`/weather export` writes a versioned JSONL archive to a new private file under
`var/export/`. It contains coordinates, household device identifiers, raw reports,
labels and undo history. Failed exports are removed. Export copies do not update
automatically. Back up the SQLite database using a SQLite-aware backup or stop
Automaton before copying it (including its WAL if present).

## Evidence and installation

Each archive event has a monotonically increasing ID. Samples contain report and
entry times (UTC epoch milliseconds), the exact reported property, sensor ID,
location and full installation snapshot. Missing properties create no samples;
cached device state is never treated as fresh. Explicit invalid values are saved
as invalid evidence with null/nonnegative-value quality handling. Values at or
above an optional `max_lux` are marked clipped.

Each observation stores its own preceding 15-minute report window, sample ages,
quality, freshness result, label and installation/location context in one SQLite
insert. It preserves a human observation even when all measurements are missing,
stale, clipped or invalid, and says so in the acknowledgment. Future reports are
excluded. Only matching installation/location snapshots enter the observation.
Adding a west sensor preserves matching east-sensor evidence; compatibility is
checked per sensor rather than requiring an identical whole sensor list.
Raw timestamps and coordinates allow solar geometry and features to be recomputed
later; no solar or classification dependency is needed during data collection.
`featureVersion: null` explicitly means features have not yet been generated.

Give every sensor a unique stable `id`, explicit device/property mapping and an
`installation` version. Increment installation after moving, rotating or replacing
a sensor. `azimuth_degrees` is the sensing-face bearing clockwise from north;
`tilt_degrees` is zero for upward horizontal and 90 for vertical. Confirm mounting
orientation before treating these values as measured metadata. Set `max_lux` only
after verifying the hardware's range, units and saturation behavior. Set
`max_age_seconds` from observed reporting cadence (default 300 seconds); the
initial implementation never treats readings older than the 15-minute window as
usable, even if a larger freshness limit is configured.

The archive has deliberately **no automatic retention** during this experiment.
Ordinary seven-day sensor-history pruning and transition-history pruning never
touch it. Allow roughly 1 KB per sensor report plus database/index overhead:
at one report per minute, roughly 1.4 MB/day per sensor; measure the database on
this installation because actual payload and report cadence vary. Labels also
copy their short evidence windows. No observations are automatically expanded
into labels for neighboring raw samples. There is currently no import or archive
deletion command.

## Proposed classifier and Weatherman delivery

1. Audit actual report cadence, clipping and missingness using the archive. Gather
   sunny, cloudy and overcast observations across different days and sun positions.
2. Compute shared versioned features offline and live from timestamps, valid
   coordinates and matching installations: solar elevation/azimuth, per-sensor
   brightness, bounded time-weighted variation, freshness and coverage. Reject low
   sun, invalid coordinates and unsupported installations.
3. Fit a local clear-sky reference from sunny labels, with minimum support in each
   solar region. Compare normalized brightness baselines and a small classifier.
   Ignore undone/unsure/unusable labels; keep predictions separate from labels.
4. Evaluate on whole held-out days, including abstention, per-class errors and
   morning/afternoon coverage. Publish a versioned model only after review; record
   training IDs, feature version and installation/location compatibility.
5. Add shadow inference with a separate future `daylight.inference_enabled` flag.
   Run inference silently first, expiring stale evidence to unknown and requiring
   persistence before state changes. The existing `daylight.announcements_enabled`
   flag gates Weatherman's qualified localized sentence outside comfort-rule
   selection; unknown produces no sentence on direct, AI and fallback paths.

The data collected now supports that pipeline without relabeling or relying on
short-lived operational history. No classification accuracy is claimed yet.

## Adding the west sensor

Keep the east entry and add a second item under `daylight.sensors`:

```yaml
- id: balcony_west
  device: 'West Luminance'  # replace with its actual Zigbee2MQTT name
  property: illuminance
  installation: balcony-west-v1
  azimuth_degrees: 270
  tilt_degrees: 90
  max_age_seconds: 300
```

The existing east entry uses azimuth 90. Check the sensing-face tilt at installation.
These fields are saved metadata; the collector does not apply a noon cutoff or
interpret lux as cloud cover. A future model must calibrate east and west
independently against solar elevation and azimuth, then combine supported sensor
features. That allows clear afternoon labels with a shaded east sensor to teach
the local baseline. Keep labeling across mornings and afternoons. Existing
single-sensor observations remain in the archive after adding west; west will
need its own calibration. Clock noon alone does not describe the sun's position
relative to this installation throughout the year.
