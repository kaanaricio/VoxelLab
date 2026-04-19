// TID 1500 SR content tree (dcmjs-compatible naturalized dataset).

import { uid, nowDicomDateTime } from './dicom-sr-utils.js';

function codedValue(value, scheme, meaning) {
  return {
    CodeValue: value,
    CodingSchemeDesignator: scheme,
    CodeMeaning: meaning,
  };
}

export function buildSRDataset(bundle) {
  const { slug, measurements } = bundle;
  if (!measurements.length) throw new Error('No measurements to export');

  const studyInstanceUid = uid();
  const seriesInstanceUid = uid();
  const sopInstanceUid   = uid();
  const now = nowDicomDateTime();
  const date = now.slice(0, 8), time = now.slice(8);

  const measurementGroups = measurements.map((m, i) => {
    const container = {
      ValueType: 'CONTAINER',
      ConceptNameCodeSequence: [codedValue('125007', 'DCM', 'Measurement Group')],
      ContinuityOfContent: 'SEPARATE',
      ContentSequence: [],
    };

    container.ContentSequence.push({
      RelationshipType: 'HAS OBS CONTEXT',
      ValueType: 'TEXT',
      ConceptNameCodeSequence: [codedValue('112039', 'DCM', 'Tracking Identifier')],
      TextValue: `mri-viewer.${slug}.${i + 1}`,
    });
    container.ContentSequence.push({
      RelationshipType: 'HAS OBS CONTEXT',
      ValueType: 'UIDREF',
      ConceptNameCodeSequence: [codedValue('112040', 'DCM', 'Tracking Unique Identifier')],
      UID: uid(),
    });

    if (m.kind === 'length') {
      container.ContentSequence.push({
        RelationshipType: 'CONTAINS',
        ValueType: 'NUM',
        ConceptNameCodeSequence: [codedValue('410668003', 'SCT', 'Length')],
        MeasuredValueSequence: [{
          NumericValue: m.length_mm.toFixed(2),
          MeasurementUnitsCodeSequence: [codedValue('mm', 'UCUM', 'millimeter')],
        }],
      });
    } else if (m.kind === 'angle') {
      container.ContentSequence.push({
        RelationshipType: 'CONTAINS',
        ValueType: 'NUM',
        ConceptNameCodeSequence: [codedValue('121206', 'DCM', 'Angle')],
        MeasuredValueSequence: [{
          NumericValue: m.angle_deg.toFixed(2),
          MeasurementUnitsCodeSequence: [codedValue('deg', 'UCUM', 'degree')],
        }],
      });
    } else if (m.kind === 'ellipse' || m.kind === 'polygon') {
      if (m.stats) {
        container.ContentSequence.push({
          RelationshipType: 'CONTAINS',
          ValueType: 'NUM',
          ConceptNameCodeSequence: [codedValue('42798000', 'SCT', 'Area')],
          MeasuredValueSequence: [{
            NumericValue: m.stats.area_mm2.toFixed(2),
            MeasurementUnitsCodeSequence: [codedValue('mm2', 'UCUM', 'square millimeter')],
          }],
        });
        container.ContentSequence.push({
          RelationshipType: 'CONTAINS',
          ValueType: 'NUM',
          ConceptNameCodeSequence: [codedValue('126030', 'DCM', 'Mean')],
          MeasuredValueSequence: [{
            NumericValue: m.stats.mean.toFixed(2),
            MeasurementUnitsCodeSequence: [codedValue('1', 'UCUM', 'no units')],
          }],
        });
        container.ContentSequence.push({
          RelationshipType: 'CONTAINS',
          ValueType: 'NUM',
          ConceptNameCodeSequence: [codedValue('126031', 'DCM', 'Standard Deviation')],
          MeasuredValueSequence: [{
            NumericValue: m.stats.std.toFixed(2),
            MeasurementUnitsCodeSequence: [codedValue('1', 'UCUM', 'no units')],
          }],
        });
        if (m.stats.adc) {
          container.ContentSequence.push({
            RelationshipType: 'CONTAINS',
            ValueType: 'NUM',
            ConceptNameCodeSequence: [codedValue('113041', 'DCM', 'Apparent Diffusion Coefficient')],
            MeasuredValueSequence: [{
              NumericValue: (m.stats.adc.mean * 1e-3).toFixed(6),
              MeasurementUnitsCodeSequence: [codedValue('mm2/s', 'UCUM', 'square millimeters per second')],
            }],
          });
        }
      }
    } else if (m.kind === 'text') {
      container.ContentSequence.push({
        RelationshipType: 'CONTAINS',
        ValueType: 'TEXT',
        ConceptNameCodeSequence: [codedValue('121106', 'DCM', 'Comment')],
        TextValue: m.text,
      });
    }

    container.ContentSequence.push({
      RelationshipType: 'HAS OBS CONTEXT',
      ValueType: 'TEXT',
      ConceptNameCodeSequence: [codedValue('112002', 'DCM', 'Referenced Series')],
      TextValue: `${slug} slice ${m.slice + 1}`,
    });

    return container;
  });

  const dataset = {
    _meta: {
      FileMetaInformationVersion: new Uint8Array([0, 1]),
      MediaStorageSOPClassUID: '1.2.840.10008.5.1.4.1.1.88.33',
      MediaStorageSOPInstanceUID: sopInstanceUid,
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      ImplementationClassUID: '2.25.1.1.1',
      ImplementationVersionName: 'MRI-VIEWER-1.0',
    },

    PatientName: 'Anonymous',
    PatientID:   'anonymous',
    PatientBirthDate: '',
    PatientSex:  '',

    StudyInstanceUID: studyInstanceUid,
    StudyDate: date,
    StudyTime: time,
    AccessionNumber: '',
    ReferringPhysicianName: '',
    StudyID: '1',

    Modality: 'SR',
    SeriesInstanceUID: seriesInstanceUid,
    SeriesNumber: '1',
    SeriesDate: date,
    SeriesTime: time,

    SOPClassUID: '1.2.840.10008.5.1.4.1.1.88.33',
    SOPInstanceUID: sopInstanceUid,
    InstanceNumber: '1',
    ContentDate: date,
    ContentTime: time,
    ValueType: 'CONTAINER',
    ConceptNameCodeSequence: [codedValue('126000', 'DCM', 'Imaging Measurement Report')],
    ContinuityOfContent: 'SEPARATE',
    PerformedProcedureCodeSequence: [],
    CompletionFlag: 'COMPLETE',
    VerificationFlag: 'UNVERIFIED',

    ContentSequence: [
      {
        RelationshipType: 'HAS CONCEPT MOD',
        ValueType: 'CODE',
        ConceptNameCodeSequence: [codedValue('121049', 'DCM', 'Language of Content Item and Descendants')],
        ConceptCodeSequence: [codedValue('eng', 'RFC5646', 'English')],
      },
      {
        RelationshipType: 'HAS OBS CONTEXT',
        ValueType: 'TEXT',
        ConceptNameCodeSequence: [codedValue('121008', 'DCM', 'Person Observer Name')],
        TextValue: 'Medical Imaging Viewer',
      },
      {
        RelationshipType: 'CONTAINS',
        ValueType: 'CONTAINER',
        ConceptNameCodeSequence: [codedValue('126010', 'DCM', 'Imaging Measurements')],
        ContinuityOfContent: 'SEPARATE',
        ContentSequence: measurementGroups,
      },
    ],
  };

  return dataset;
}
