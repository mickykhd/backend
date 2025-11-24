import mongoose from 'mongoose';

const dashboardMappingSchema = new mongoose.Schema({
  projectId: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  dashboardId: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  collection: 'metabase'
});

dashboardMappingSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('DashboardMapping', dashboardMappingSchema);
