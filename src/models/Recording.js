import mongoose from 'mongoose';

export const STAGES = ['upload', 'transcription', 'diarization', 'transcript', 'summary', 'action_items', 'insights'];
export const STATUSES = ['recording', 'queued', 'processing', 'completed', 'failed'];

const { Schema } = mongoose;

const stageSchema = new Schema(
  {
    key: { type: String, enum: STAGES, required: true },
    status: { type: String, enum: ['pending', 'running', 'done', 'failed', 'skipped'], default: 'pending' },
    startedAt: Date,
    finishedAt: Date,
    error: String,
  },
  { _id: false }
);

const noticeSchema = new Schema({ code: String, message: String }, { _id: false });

const recordingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    titleSource: { type: String, enum: ['auto', 'user'], default: 'auto' },
    source: { type: String, enum: ['live', 'upload'], required: true },

    status: { type: String, enum: STATUSES, default: 'queued' },
    stage: { type: String, default: 'upload' },
    stages: { type: [stageSchema], default: () => STAGES.map((key) => ({ key })) },
    error: { code: String, message: String, stage: String, retryable: Boolean },
    retryInfo: { attempt: Number, maxAttempts: Number, nextRunAt: Date, message: String },
    warnings: { type: [noticeSchema], default: [] },

    audio: {
      key: String,
      mimeType: String,
      size: Number,
      originalName: String,
    },
    durationSec: { type: Number, default: 0 },
    language: String,

    // live streaming state
    liveChunks: { type: Number, default: 0 },
    audioGap: { type: Boolean, default: false },
    lastActivityAt: Date,

    speakers: [{ _id: false, label: String, name: { type: String, default: '', maxlength: 60 } }],

    summary: {
      overview: String,
      topics: [String],
      decisions: [String],
      outcome: String,
    },
    actionItems: [{ _id: false, text: String, owner: String, due: String, done: { type: Boolean, default: false } }],
    keyDecisions: [String],
    keywords: [String],

    // for text search, not returned in lists
    transcriptText: { type: String, select: false },
    stats: { segmentCount: Number, wordCount: Number, avgConfidence: Number, speakerCount: Number },

    completedAt: Date,
  },
  { timestamps: true }
);

recordingSchema.index({ user: 1, createdAt: -1 });
recordingSchema.index({ user: 1, status: 1 });
recordingSchema.index({ status: 1, lastActivityAt: 1 });
recordingSchema.index(
  { title: 'text', keywords: 'text', 'summary.overview': 'text', transcriptText: 'text' },
  { name: 'recording_search', weights: { title: 10, keywords: 6, 'summary.overview': 3, transcriptText: 1 } }
);

recordingSchema.methods.addWarning = function addWarning(code, message) {
  if (!this.warnings.some((w) => w.code === code)) this.warnings.push({ code, message });
};

export const Recording = mongoose.model('Recording', recordingSchema);
