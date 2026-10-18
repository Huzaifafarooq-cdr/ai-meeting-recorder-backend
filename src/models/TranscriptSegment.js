import mongoose from 'mongoose';

const segmentSchema = new mongoose.Schema(
  {
    recording: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', required: true },
    kind: { type: String, enum: ['live', 'final'], required: true },
    idx: { type: Number, required: true },
    speaker: { type: String, default: 'Speaker A' },
    start: { type: Number, default: 0 },
    end: { type: Number, default: 0 },
    text: { type: String, default: '' },
    cleanText: String,
    confidence: Number,
  },
  { versionKey: false }
);

segmentSchema.index({ recording: 1, kind: 1, idx: 1 }, { unique: true });

export const TranscriptSegment = mongoose.model('TranscriptSegment', segmentSchema);
